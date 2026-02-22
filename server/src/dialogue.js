import OpenAI from "openai";

const IMMERSION_RULE =
  "You are writing in-world medieval/cozy town dialogue for a pixel-art fantasy town. Avoid references to modern technology, internet, smartphones, or LLMs.";

const SMALL_TALK_TOPICS = [
  "their daily routine",
  "food and cooking",
  "neighbors and town personalities",
  "weather and mood",
  "work frustrations or pride",
  "small personal worries",
  "hopes for tomorrow",
  "a funny thing seen in town",
  "local places and atmosphere"
];

function extractJsonString(text) {
  if (!text) return "";
  const trimmed = text.trim();
  const fenceMatch = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  const unfenced = fenceMatch ? fenceMatch[1].trim() : trimmed;

  const firstBrace = unfenced.indexOf("{");
  const lastBrace = unfenced.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    return unfenced.slice(firstBrace, lastBrace + 1);
  }
  return unfenced;
}

function cleanLineText(text) {
  if (!text) return "";
  const trimmed = text.trim();
  const quotedLine = trimmed.match(/"line"\s*:\s*"([^"]+)"/i);
  if (quotedLine?.[1]) {
    return quotedLine[1];
  }

  return trimmed
    .replace(/^```(?:json)?/i, "")
    .replace(/```$/i, "")
    .replace(/^\s*json\s*/i, "")
    .trim();
}

function shortenLine(text, maxWords = 14) {
  if (!text) return "";
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length <= maxWords) return words.join(" ");
  return `${words.slice(0, maxWords).join(" ")}...`;
}

function sanitizeMissionObjectiveType(value) {
  const v = String(value || "")
    .trim()
    .toLowerCase();
  if (v === "visit_area" || v === "talk_to_any_npc" || v === "talk_to_role" || v === "harvest_any") {
    return v;
  }
  return "talk_to_any_npc";
}

function sanitizeDynamicObjectiveType(value) {
  const v = String(value || "")
    .trim()
    .toLowerCase();
  const allowed = new Set([
    "talk_npc",
    "talk_role",
    "visit_area",
    "harvest_count",
    "talk_unique_npcs",
    "visit_unique_areas"
  ]);
  return allowed.has(v) ? v : "talk_unique_npcs";
}

function fallbackLine(speaker, target, worldContext) {
  const roleLineByRole = {
    Businessman: "I smile at customers, then panic over rent and cart fees.",
    Politician: "People think I love speeches; I mostly lose sleep over everyone.",
    Fisherman: "Some mornings I hum to nets; it keeps my hands steady.",
    "Shop Owner": "I remember who buys sweets when they're sad. It's never random.",
    Artist: "I keep chasing light on walls. It changes faster than people.",
    "Religious Devotee": "Most days I listen more than I preach. Folks carry heavy hearts.",
    Cultist: "Even I need normal days: soup, silence, and no omens.",
    "Town Guard": "I act stern, but I check doors softly so children sleep.",
    Herbalist: "I dry herbs at dawn; the scent makes hard days gentler.",
    Blacksmith: "Hammering calms me more than talking ever has."
  };

  const base = roleLineByRole[speaker.role] || "It's an ordinary day, and that's a blessing.";
  const phase = speaker?.routineState?.phase ? `, ${speaker.routineState.phase}` : "";
  return `${base} (${worldContext.timeLabel}, ${speaker.area}${phase})`;
}

function heuristicRelationshipDelta(text) {
  const raw = String(text || "").toLowerCase();
  if (!raw) return 0;
  const pos = ["thank", "help", "trust", "friend", "kind", "good", "appreciate", "glad"];
  const neg = ["hate", "blame", "liar", "thief", "angry", "cold", "threat", "fight"];
  let score = 0;
  for (const p of pos) {
    if (raw.includes(p)) score += 1;
  }
  for (const n of neg) {
    if (raw.includes(n)) score -= 1;
  }
  if (score >= 2) return 1;
  if (score <= -2) return -1;
  return 0;
}

function heuristicMemoryEvent(playerText) {
  const raw = String(playerText || "").trim();
  const text = raw.toLowerCase();
  if (!text) return { category: "none", summary: "", importance: 0 };
  if (/\b(i will|i'll|promise|swear|tomorrow i|later i)\b/.test(text)) {
    return {
      category: "promise",
      summary: `Player made a promise: "${raw.slice(0, 120)}"`,
      importance: 6
    };
  }
  if (/\b(give|gift|bring you|for you|take this)\b/.test(text)) {
    return {
      category: "gift",
      summary: `Player offered a gift/favor: "${raw.slice(0, 120)}"`,
      importance: 5
    };
  }
  if (/\b(stupid|idiot|hate you|liar|shut up)\b/.test(text)) {
    return {
      category: "insult",
      summary: `Player insulted the NPC: "${raw.slice(0, 120)}"`,
      importance: 7
    };
  }
  if (/\b(sorry|apologize|my fault|forgive me)\b/.test(text)) {
    return {
      category: "apology",
      summary: `Player apologized: "${raw.slice(0, 120)}"`,
      importance: 5
    };
  }
  if (/\b(i lied|not true|i made that up)\b/.test(text)) {
    return {
      category: "lie_confession",
      summary: `Player admitted dishonesty: "${raw.slice(0, 120)}"`,
      importance: 7
    };
  }
  return { category: "none", summary: "", importance: 0 };
}

export class DialogueService {
  constructor(apiKey) {
    this.client = apiKey ? new OpenAI({ apiKey }) : null;
    this.relationshipShiftCache = new Map();
    this.followupHintCache = new Map();
  }

  pruneCache(cache, maxSize = 2000) {
    if (!(cache instanceof Map)) return;
    if (cache.size <= maxSize) return;
    const now = Date.now();
    for (const [key, value] of cache.entries()) {
      if (!value || Number(value.expiresAt) <= now) {
        cache.delete(key);
      }
    }
    if (cache.size <= maxSize) return;
    const keys = [...cache.keys()];
    for (let i = 0; i < keys.length - maxSize; i += 1) {
      cache.delete(keys[i]);
    }
  }

  async generateNpcLine({ speaker, target, worldContext, memories, topicHint }) {
    if (!this.client) {
      return {
        line: shortenLine(fallbackLine(speaker, target, worldContext)),
        emotion: "neutral",
        memoryWrite: `${speaker.name} discussed ${topicHint || "daily worries"} with ${target.name}.`
      };
    }

    const prompt = [
      `Speaker: ${speaker.name}, role=${speaker.role}, traits=${speaker.traits.join(", ")}`,
      `Speaker routine now: ${
        speaker?.routineState
          ? JSON.stringify({
              phase: speaker.routineState.phase,
              venueType: speaker.routineState.venueType,
              areaName: speaker.routineState.areaName,
              isHoliday: speaker.routineState.isHoliday
            })
          : "unknown"
      }`,
      `Speaker profile: ${
        speaker?.characterProfile
          ? JSON.stringify({
              role: speaker.characterProfile.role,
              homeArea: speaker.characterProfile.homeArea,
              work: speaker.characterProfile.work,
              holidayLabel: speaker.characterProfile.holidayLabel,
              afterWorkVenues: speaker.characterProfile.afterWorkVenues
            })
          : "none"
      }`,
      `Target: ${target.name}, role=${target.role}`,
      `Time: ${worldContext.timeLabel}, Area: ${speaker.area}, Weather: ${worldContext.weather}`,
      `Town rumor (optional context, not required): ${worldContext.rumorOfTheDay}`,
      `Topic hint: ${topicHint || "local town matters"}`,
      `Natural conversation topics to prefer: ${SMALL_TALK_TOPICS.join(", ")}`,
      `Recent memories: ${memories.map((m) => m.content).join(" | ") || "none"}`
    ].join("\n");

    const response = await this.client.responses.create({
      model: "gpt-4.1-mini",
      input: [
        {
          role: "system",
          content: `${IMMERSION_RULE}
Keep each line under 14 words.
Write like a real person with personality, not an NPC mission bot.
Prioritize daily-life talk: feelings, work, neighbors, food, weather, little observations.
Use the speaker's routine/profile naturally (work shift, day off, favorite hangouts) when relevant.
Only occasionally mention rumors/duties/quests, and only when natural (rare).
When replying to a player's message, usually respond to their topic/tone directly, but sometimes pivot naturally.`
        },
        {
          role: "developer",
          content:
            "Output JSON with keys line, emotion, memoryWrite. Return only raw JSON, no markdown/code fences. Keep tone in-character and context-aware. memoryWrite should summarize human-like social content briefly."
        },
        { role: "user", content: prompt }
      ]
    });

    const text = response.output_text?.trim();
    try {
      const parsed = JSON.parse(extractJsonString(text));
      return {
        line: shortenLine(parsed.line || fallbackLine(speaker, target, worldContext)),
        emotion: parsed.emotion || "neutral",
        memoryWrite: parsed.memoryWrite || `${speaker.name} chatted with ${target.name}.`
      };
    } catch {
      return {
        line: shortenLine(cleanLineText(text) || fallbackLine(speaker, target, worldContext)),
        emotion: "neutral",
        memoryWrite: `${speaker.name} chatted with ${target.name}.`
      };
    }
  }

  async analyzeRelationshipShift({ speaker, target, line, contextHint }) {
    const fallbackDelta = heuristicRelationshipDelta(line);
    const cacheKey = [
      String(speaker?.name || ""),
      String(target?.name || ""),
      String(line || "").slice(0, 180),
      String(contextHint || "").slice(0, 120)
    ].join("|");
    const now = Date.now();
    const cached = this.relationshipShiftCache.get(cacheKey);
    if (cached && Number(cached.expiresAt) > now) {
      return cached.value;
    }
    if (!this.client) {
      const out = {
        delta: fallbackDelta,
        rationale: "heuristic-only"
      };
      this.relationshipShiftCache.set(cacheKey, { value: out, expiresAt: now + 15_000 });
      return out;
    }

    const prompt = [
      `Speaker: ${speaker?.name || "Unknown"} (${speaker?.role || "role"})`,
      `Target: ${target?.name || "Unknown"} (${target?.role || "role"})`,
      `Line: ${String(line || "").slice(0, 220)}`,
      `Context: ${String(contextHint || "").slice(0, 180)}`
    ].join("\n");

    try {
      const response = await this.client.responses.create({
        model: "gpt-4.1-mini",
        input: [
          {
            role: "system",
            content: `${IMMERSION_RULE}
Assess how this line would affect relationship tone between speaker and target.
Return small change only.`
          },
          {
            role: "developer",
            content:
              "Return raw JSON only with keys: delta, rationale. delta must be one of -2,-1,0,1,2."
          },
          { role: "user", content: prompt }
        ]
      });
      const text = response.output_text?.trim();
      const parsed = JSON.parse(extractJsonString(text));
      const rawDelta = Number(parsed?.delta);
      const clamped = [-2, -1, 0, 1, 2].includes(rawDelta) ? rawDelta : fallbackDelta;
      const out = {
        delta: clamped,
        rationale: String(parsed?.rationale || "ai-assessed").slice(0, 140)
      };
      this.relationshipShiftCache.set(cacheKey, { value: out, expiresAt: now + 20_000 });
      this.pruneCache(this.relationshipShiftCache, 1500);
      return out;
    } catch {
      const out = {
        delta: fallbackDelta,
        rationale: "heuristic-fallback"
      };
      this.relationshipShiftCache.set(cacheKey, { value: out, expiresAt: now + 15_000 });
      return out;
    }
  }

  async generateTownMission({ worldContext, townLog, areaNames, roleNames }) {
    const fallback = {
      title: "Town Chatter",
      description: "Hear what people are saying around town.",
      objectiveType: "talk_to_any_npc",
      targetCount: 2,
      gossip: worldContext?.rumorOfTheDay || "People are talking all over town."
    };

    if (!this.client) {
      return fallback;
    }

    const prompt = [
      `Time: ${worldContext?.timeLabel || "morning"}, Day: ${worldContext?.dayNumber || 1}, Weather: ${worldContext?.weather || "clear"}`,
      `Rumor: ${worldContext?.rumorOfTheDay || "none"}`,
      `Recent town log: ${(townLog || []).slice(-10).join(" | ") || "none"}`,
      `Areas: ${(areaNames || []).join(", ")}`,
      `Roles: ${(roleNames || []).join(", ")}`
    ].join("\n");

    const response = await this.client.responses.create({
      model: "gpt-4.1-mini",
      input: [
        {
          role: "system",
          content: `${IMMERSION_RULE}
Design one short, doable, situational town mission based on current gossip/events.
Mission must be grounded in what people are discussing.
Objective must be one of: visit_area, talk_to_any_npc, talk_to_role, harvest_any.
Keep it simple and completable within a short play session.`
        },
        {
          role: "developer",
          content:
            "Return raw JSON only with keys: title, description, objectiveType, targetArea, targetRole, targetCount, gossip."
        },
        { role: "user", content: prompt }
      ]
    });

    const text = response.output_text?.trim();
    try {
      const parsed = JSON.parse(extractJsonString(text));
      return {
        title: String(parsed.title || fallback.title).slice(0, 60),
        description: String(parsed.description || fallback.description).slice(0, 180),
        objectiveType: sanitizeMissionObjectiveType(parsed.objectiveType),
        targetArea: parsed.targetArea ? String(parsed.targetArea).slice(0, 40) : null,
        targetRole: parsed.targetRole ? String(parsed.targetRole).slice(0, 40) : null,
        targetCount: Math.max(1, Math.min(4, Number(parsed.targetCount) || fallback.targetCount)),
        gossip: String(parsed.gossip || fallback.gossip).slice(0, 180)
      };
    } catch {
      return fallback;
    }
  }

  async generateStoryMission({ worldContext, townLog, npcs, areaNames, roleNames, questSignals }) {
    const fallback = {
      title: "Town Threads",
      description: "Talk with 2 different townsfolk to follow today's chatter.",
      objectiveType: "talk_unique_npcs",
      targetCount: 2,
      targetArea: null,
      targetRole: null,
      targetNpcName: null,
      urgency: 2,
      whyNow: "People are actively discussing this today.",
      gossip: worldContext?.rumorOfTheDay || "Town chatter shifts by the hour."
    };

    if (!this.client) {
      return fallback;
    }

    const prompt = [
      `Day: ${worldContext?.dayNumber || 1}, Time: ${worldContext?.timeLabel || "morning"}, Weather: ${worldContext?.weather || "clear"}`,
      `Rumor: ${worldContext?.rumorOfTheDay || "none"}`,
      `Recent town log: ${(townLog || []).slice(-16).join(" | ") || "none"}`,
      `NPCs: ${(npcs || []).map((n) => `${n.name} (${n.role}) @ ${n.area}`).join(" | ") || "none"}`,
      `Areas: ${(areaNames || []).join(", ") || "none"}`,
      `Roles: ${(roleNames || []).join(", ") || "none"}`,
      `Quest signals: ${
        questSignals && typeof questSignals === "object" ? JSON.stringify(questSignals) : "none"
      }`
    ].join("\n");

    const response = await this.client.responses.create({
      model: "gpt-4.1-mini",
      input: [
        {
          role: "system",
          content: `${IMMERSION_RULE}
Create one dynamic player mission from recent NPC talk and town events.
Mission must be short and completable in one session.
Ground it in the recent log and current NPC social activity.
Allowed objectiveType values only: talk_npc, talk_role, visit_area, harvest_count, talk_unique_npcs, visit_unique_areas.`
        },
        {
          role: "developer",
          content:
            "Return raw JSON only with keys: title, description, objectiveType, targetNpcName, targetRole, targetArea, targetCount, urgency, whyNow, gossip."
        },
        { role: "user", content: prompt }
      ]
    });

    const text = response.output_text?.trim();
    try {
      const parsed = JSON.parse(extractJsonString(text));
      return {
        title: String(parsed.title || fallback.title).slice(0, 60),
        description: String(parsed.description || fallback.description).slice(0, 180),
        objectiveType: sanitizeDynamicObjectiveType(parsed.objectiveType),
        targetNpcName: parsed.targetNpcName ? String(parsed.targetNpcName).slice(0, 40) : null,
        targetRole: parsed.targetRole ? String(parsed.targetRole).slice(0, 40) : null,
        targetArea: parsed.targetArea ? String(parsed.targetArea).slice(0, 40) : null,
        targetCount: Math.max(1, Math.min(5, Number(parsed.targetCount) || fallback.targetCount)),
        urgency: Math.max(1, Math.min(3, Number(parsed.urgency) || fallback.urgency)),
        whyNow: String(parsed.whyNow || fallback.whyNow).slice(0, 140),
        gossip: String(parsed.gossip || fallback.gossip).slice(0, 180)
      };
    } catch {
      return fallback;
    }
  }

  async generateStoryArc({ worldContext, townLog, areaNames, roleNames }) {
    const fallback = {
      title: "Lantern Unease",
      summary: "Rumors around the shrine are making people cautious after dark.",
      stages: [
        "Gather firsthand reports in busy areas.",
        "Check the shrine rumor against witness stories.",
        "Settle the town mood by sharing what is true."
      ],
      branchA: "If rumors were exaggerated, town calms quickly.",
      branchB: "If reports confirm danger, guards tighten patrols."
    };

    if (!this.client) return fallback;

    const prompt = [
      `Day: ${worldContext?.dayNumber || 1}, Time: ${worldContext?.timeLabel || "morning"}, Weather: ${worldContext?.weather || "clear"}`,
      `Rumor: ${worldContext?.rumorOfTheDay || "none"}`,
      `Recent town log: ${(townLog || []).slice(-24).join(" | ") || "none"}`,
      `Areas: ${(areaNames || []).join(", ") || "none"}`,
      `Roles: ${(roleNames || []).join(", ") || "none"}`
    ].join("\n");

    try {
      const response = await this.client.responses.create({
        model: "gpt-4.1-mini",
        input: [
          {
            role: "system",
            content: `${IMMERSION_RULE}
Create a short multi-day town story arc grounded in recent social chatter.
Arc should be practical for gameplay and include 3 concise stages.`
          },
          {
            role: "developer",
            content:
              "Return raw JSON only with keys: title, summary, stages, branchA, branchB. stages must be an array of 3 short strings."
          },
          { role: "user", content: prompt }
        ]
      });
      const parsed = JSON.parse(extractJsonString(response.output_text || ""));
      const rawStages = Array.isArray(parsed?.stages) ? parsed.stages : [];
      const stages = rawStages
        .map((s) => String(s || "").trim())
        .filter(Boolean)
        .slice(0, 3);
      while (stages.length < 3) {
        stages.push(fallback.stages[stages.length]);
      }
      return {
        title: String(parsed?.title || fallback.title).slice(0, 60),
        summary: String(parsed?.summary || fallback.summary).slice(0, 180),
        stages,
        branchA: String(parsed?.branchA || fallback.branchA).slice(0, 140),
        branchB: String(parsed?.branchB || fallback.branchB).slice(0, 140)
      };
    } catch {
      return fallback;
    }
  }

  async generateRoutineNudges({ worldContext, townLog, roleNames, areaNames }) {
    const fallback = [];
    if (!this.client) return fallback;

    const prompt = [
      `Day: ${worldContext?.dayNumber || 1}, Weather: ${worldContext?.weather || "clear"}, Time: ${worldContext?.timeLabel || "morning"}`,
      `Rumor: ${worldContext?.rumorOfTheDay || "none"}`,
      `Recent log: ${(townLog || []).slice(-20).join(" | ") || "none"}`,
      `Roles: ${(roleNames || []).join(", ") || "none"}`,
      `Areas: ${(areaNames || []).join(", ") || "none"}`
    ].join("\n");

    try {
      const response = await this.client.responses.create({
        model: "gpt-4.1-mini",
        input: [
          {
            role: "system",
            content: `${IMMERSION_RULE}
Suggest small same-day routine adjustments by role from social mood and weather.
Keep changes modest and practical.`
          },
          {
            role: "developer",
            content:
              "Return raw JSON only as an array of up to 5 objects with keys: role, shiftMinutes, afterWorkArea, reason."
          },
          { role: "user", content: prompt }
        ]
      });
      const parsed = JSON.parse(extractJsonString(response.output_text || "[]"));
      if (!Array.isArray(parsed)) return fallback;
      return parsed.slice(0, 5).map((n) => ({
        role: String(n?.role || "").slice(0, 40),
        shiftMinutes: Math.max(-120, Math.min(120, Number(n?.shiftMinutes) || 0)),
        afterWorkArea: n?.afterWorkArea ? String(n.afterWorkArea).slice(0, 40) : "",
        reason: String(n?.reason || "").slice(0, 120)
      }));
    } catch {
      return fallback;
    }
  }

  async generateEconomyPlan({ worldContext, townLog, cropTypes }) {
    const fallback = {
      mood: "steady",
      cropPrices: {
        turnip: 8,
        carrot: 10,
        pumpkin: 18
      },
      demand: {
        turnip: "normal",
        carrot: "normal",
        pumpkin: "normal"
      },
      missionRewardMultiplier: 1,
      note: "Market is steady."
    };
    if (!this.client) return fallback;

    const prompt = [
      `Day: ${worldContext?.dayNumber || 1}, Weather: ${worldContext?.weather || "clear"}, Time: ${worldContext?.timeLabel || "morning"}`,
      `Rumor: ${worldContext?.rumorOfTheDay || "none"}`,
      `Recent town log: ${(townLog || []).slice(-24).join(" | ") || "none"}`,
      `Crop types: ${(cropTypes || []).join(", ") || "turnip, carrot, pumpkin"}`
    ].join("\n");

    try {
      const response = await this.client.responses.create({
        model: "gpt-4.1-mini",
        input: [
          {
            role: "system",
            content: `${IMMERSION_RULE}
Design one day market conditions from social chatter.
Return practical prices and demand only.`
          },
          {
            role: "developer",
            content:
              "Return raw JSON with keys: mood, cropPrices, demand, missionRewardMultiplier, note. cropPrices should map each crop to integer price. demand values: high|normal|low."
          },
          { role: "user", content: prompt }
        ]
      });
      const parsed = JSON.parse(extractJsonString(response.output_text || "{}"));
      const cropPrices = {};
      const demand = {};
      for (const cropType of cropTypes || []) {
        const rawPrice = Number(parsed?.cropPrices?.[cropType]);
        cropPrices[cropType] = Number.isFinite(rawPrice) ? Math.max(1, Math.round(rawPrice)) : fallback.cropPrices[cropType] || 1;
        const rawDemand = String(parsed?.demand?.[cropType] || "").toLowerCase();
        demand[cropType] = rawDemand === "high" || rawDemand === "low" ? rawDemand : "normal";
      }
      return {
        mood: String(parsed?.mood || fallback.mood).slice(0, 32),
        cropPrices,
        demand,
        missionRewardMultiplier: Math.max(0.8, Math.min(1.25, Number(parsed?.missionRewardMultiplier) || 1)),
        note: String(parsed?.note || fallback.note).slice(0, 160)
      };
    } catch {
      return fallback;
    }
  }

  async generateWorldEvents({ worldContext, townLog, areaNames }) {
    const fallback = {
      active: []
    };
    if (!this.client) return fallback;
    const prompt = [
      `Day: ${worldContext?.dayNumber || 1}, Time: ${worldContext?.timeLabel || "morning"}, Weather: ${worldContext?.weather || "clear"}`,
      `Rumor: ${worldContext?.rumorOfTheDay || "none"}`,
      `Recent town log: ${(townLog || []).slice(-30).join(" | ") || "none"}`,
      `Areas: ${(areaNames || []).join(", ") || "none"}`
    ].join("\n");
    try {
      const response = await this.client.responses.create({
        model: "gpt-4.1-mini",
        input: [
          {
            role: "system",
            content: `${IMMERSION_RULE}
Create up to 2 short world events/emergencies for today based on chatter.
Events should be practical and affect gameplay tone.`
          },
          {
            role: "developer",
            content:
              "Return raw JSON object with key active (array). Each event keys: title, description, severity (1-3), area, effect (one of none,weather_shift,price_spike,guard_alert,crowd_rush)."
          },
          { role: "user", content: prompt }
        ]
      });
      const parsed = JSON.parse(extractJsonString(response.output_text || "{}"));
      const active = Array.isArray(parsed?.active) ? parsed.active : [];
      return {
        active: active.slice(0, 2).map((evt) => ({
          title: String(evt?.title || "Town Event").slice(0, 60),
          description: String(evt?.description || "Something unusual is happening in town.").slice(0, 180),
          severity: Math.max(1, Math.min(3, Number(evt?.severity) || 1)),
          area: String(evt?.area || "").slice(0, 40),
          effect: String(evt?.effect || "none").slice(0, 40)
        }))
      };
    } catch {
      return fallback;
    }
  }

  async generateFactionPulse({ worldContext, townLog, factions }) {
    const fallback = {
      groups: Array.isArray(factions?.groups) ? factions.groups : [],
      tensions: Array.isArray(factions?.tensions) ? factions.tensions : []
    };
    if (!this.client) return fallback;

    const prompt = [
      `Day: ${worldContext?.dayNumber || 1}, Weather: ${worldContext?.weather || "clear"}`,
      `Rumor: ${worldContext?.rumorOfTheDay || "none"}`,
      `Recent town log: ${(townLog || []).slice(-24).join(" | ") || "none"}`,
      `Current factions: ${JSON.stringify(factions || {})}`
    ].join("\n");

    try {
      const response = await this.client.responses.create({
        model: "gpt-4.1-mini",
        input: [
          {
            role: "system",
            content: `${IMMERSION_RULE}
Update faction influence and tensions based on latest town mood.
Keep outputs small and grounded.`
          },
          {
            role: "developer",
            content: "Return raw JSON with keys groups and tensions."
          },
          { role: "user", content: prompt }
        ]
      });
      const parsed = JSON.parse(extractJsonString(response.output_text || "{}"));
      return {
        groups: Array.isArray(parsed?.groups) ? parsed.groups : fallback.groups,
        tensions: Array.isArray(parsed?.tensions) ? parsed.tensions : fallback.tensions
      };
    } catch {
      return fallback;
    }
  }

  async classifyPlayerMemoryEvent({ playerText, npcName, contextHint }) {
    const fallback = heuristicMemoryEvent(playerText);
    if (!this.client) return fallback;

    const prompt = [
      `NPC: ${npcName || "Unknown"}`,
      `Player line: ${String(playerText || "").slice(0, 240)}`,
      `Context: ${String(contextHint || "").slice(0, 160)}`
    ].join("\n");
    try {
      const response = await this.client.responses.create({
        model: "gpt-4.1-mini",
        input: [
          {
            role: "system",
            content: `${IMMERSION_RULE}
Classify whether the player's line should become a persistent social memory for this NPC.`
          },
          {
            role: "developer",
            content:
              "Return raw JSON keys: category, summary, importance. category must be one of none,promise,gift,insult,apology,lie_confession,request."
          },
          { role: "user", content: prompt }
        ]
      });
      const parsed = JSON.parse(extractJsonString(response.output_text || "{}"));
      const allowed = new Set(["none", "promise", "gift", "insult", "apology", "lie_confession", "request"]);
      const category = allowed.has(String(parsed?.category || "")) ? String(parsed.category) : fallback.category;
      const summary = String(parsed?.summary || fallback.summary || "").slice(0, 160);
      const importance = Math.max(1, Math.min(9, Number(parsed?.importance) || fallback.importance || 4));
      return { category, summary, importance };
    } catch {
      return fallback;
    }
  }

  async generateNextDayFollowup({ npc, playerName, worldContext, recentPlayerMemories, prioritizedThreads, townLog }) {
    const key = [
      String(npc?.id || npc?.name || ""),
      String(playerName || ""),
      String(worldContext?.dayNumber || ""),
      (prioritizedThreads || []).slice(0, 2).join("|"),
      (recentPlayerMemories || []).slice(0, 2).join("|")
    ].join("::");
    const now = Date.now();
    const cached = this.followupHintCache.get(key);
    if (cached && Number(cached.expiresAt) > now) {
      return cached.value;
    }

    const fallback = (() => {
      const preferred =
        Array.isArray(prioritizedThreads) && prioritizedThreads.length > 0
          ? prioritizedThreads
          : recentPlayerMemories;
      const memoryLine = Array.isArray(preferred) && preferred.length > 0
        ? String(preferred[0] || "").slice(0, 120)
        : "";
      if (memoryLine) {
        return `follow up on yesterday with ${playerName || "the traveler"}: ${memoryLine}`;
      }
      return `light follow-up on yesterday's town mood with ${playerName || "the traveler"}`;
    })();
    if (!this.client) {
      this.followupHintCache.set(key, { value: fallback, expiresAt: now + 60_000 });
      return fallback;
    }

    const prompt = [
      `NPC: ${npc?.name || "Unknown"} (${npc?.role || "role"})`,
      `Player: ${playerName || "Traveler"}`,
      `Day: ${worldContext?.dayNumber || 1}, Time: ${worldContext?.timeLabel || "morning"}, Weather: ${worldContext?.weather || "clear"}`,
      `Rumor: ${worldContext?.rumorOfTheDay || "none"}`,
      `Priority unresolved threads (promises/apologies): ${(prioritizedThreads || []).slice(0, 2).join(" | ") || "none"}`,
      `Recent player-linked memories: ${(recentPlayerMemories || []).slice(0, 4).join(" | ") || "none"}`,
      `Yesterday town log: ${(townLog || []).slice(-10).join(" | ") || "none"}`
    ].join("\n");

    try {
      const response = await this.client.responses.create({
        model: "gpt-4.1-mini",
        input: [
          {
            role: "system",
            content: `${IMMERSION_RULE}
Write one short next-day conversation follow-up hint for this NPC talking to the player.
If unresolved promise/apology threads are present, prioritize one of those first.
Treat these as unresolved unless explicit resolution is stated.
It should reference yesterday's social context and feel natural, not quest-like.`
          },
          {
            role: "developer",
            content: "Return raw JSON only with key followupHint (max 140 chars)."
          },
          { role: "user", content: prompt }
        ]
      });
      const parsed = JSON.parse(extractJsonString(response.output_text || "{}"));
      const followupHint = String(parsed?.followupHint || "").trim();
      const out = followupHint ? followupHint.slice(0, 140) : fallback;
      this.followupHintCache.set(key, { value: out, expiresAt: now + 10 * 60_000 });
      this.pruneCache(this.followupHintCache, 1200);
      return out;
    } catch {
      this.followupHintCache.set(key, { value: fallback, expiresAt: now + 60_000 });
      return fallback;
    }
  }
}
