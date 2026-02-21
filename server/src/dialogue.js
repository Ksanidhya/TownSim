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
  return `${base} (${worldContext.timeLabel}, ${speaker.area})`;
}

export class DialogueService {
  constructor(apiKey) {
    this.client = apiKey ? new OpenAI({ apiKey }) : null;
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
}
