import OpenAI from "openai";

const IMMERSION_RULE =
  "You are writing in-world medieval/cozy town dialogue for a pixel-art fantasy town. Avoid references to modern technology, internet, smartphones, or LLMs.";

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

function fallbackLine(speaker, target, worldContext) {
  const roleLineByRole = {
    Businessman: "Margins are thin today; taxes and transport eat every coin.",
    Politician: "Order is fragile. One rumor can sway tomorrow's council vote.",
    Fisherman: "If clouds keep low at dusk, the river yields silver fin by dawn.",
    "Shop Owner": "No one leaves my stall unhappy, but I watch every ledger mark.",
    Artist: "The square looked dull, so I painted it with storm colors in my head.",
    "Religious Devotee": "Mercy and discipline must walk together, or faith dries up.",
    Cultist: "The forest listens when the bell tolls twice at moonrise.",
    "Town Guard": "I keep watch by the square; peace survives only with discipline.",
    Herbalist: "Mossleaf and rootbloom calm fevers better than any loud promise.",
    Blacksmith: "Iron speaks plain: strike true, cool slow, and the edge holds."
  };

  const base = roleLineByRole[speaker.role] || "The town feels tense today.";
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
      `Rumor: ${worldContext.rumorOfTheDay}`,
      `Topic hint: ${topicHint || "local town matters"}`,
      `Recent memories: ${memories.map((m) => m.content).join(" | ") || "none"}`
    ].join("\n");

    const response = await this.client.responses.create({
      model: "gpt-4.1-mini",
      input: [
        { role: "system", content: `${IMMERSION_RULE} Keep each line under 14 words.` },
        {
          role: "developer",
          content:
            "Output JSON with keys line, emotion, memoryWrite. Return only raw JSON, no markdown/code fences. Keep tone in-character and context-aware."
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
}
