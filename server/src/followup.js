export function makeFollowupCacheKey({ dayNumber, npcId, playerId }) {
  const day = Number(dayNumber);
  const nId = String(npcId || "").trim();
  const pId = String(playerId || "").trim();
  if (!Number.isFinite(day) || day < 1 || !nId || !pId) return "";
  return `${Math.floor(day)}:${pId}:${nId}`;
}

export function compactMemoryLines(memoryRows, maxCount = 4) {
  return (Array.isArray(memoryRows) ? memoryRows : [])
    .slice(0, Math.max(0, maxCount))
    .map((row) => String(row?.content || "").trim())
    .filter(Boolean);
}

export function composeContinuityHint({ followup = "", memoryLines = [], maxLen = 360 } = {}) {
  const cleanFollowup = String(followup || "").trim();
  const cleanMemories = (Array.isArray(memoryLines) ? memoryLines : [])
    .map((line) => String(line || "").trim())
    .filter(Boolean);
  const parts = [];
  if (cleanFollowup) {
    parts.push(`next-day follow-up: ${cleanFollowup}`);
  }
  if (cleanMemories.length > 0) {
    parts.push(cleanMemories.join(" | "));
  }
  if (parts.length === 0) return "none";
  return parts.join(" | ").slice(0, Math.max(1, Number(maxLen) || 360));
}

function parseCategoryFromTags(tagsRaw) {
  const tags = String(tagsRaw || "")
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
  const categoryTag = tags.find((tag) => tag.startsWith("category:")) || "";
  return categoryTag ? categoryTag.slice("category:".length).trim().toLowerCase() : "";
}

function appearsResolved(text) {
  const raw = String(text || "").toLowerCase();
  if (!raw) return false;
  return /\b(resolved|kept|fulfilled|made good|forgave|forgiven|apology accepted|promise kept)\b/.test(raw);
}

export function buildFollowupMemoryContext(memoryRows, maxCount = 4) {
  const resolvedByCategory = new Set();
  for (const row of Array.isArray(memoryRows) ? memoryRows : []) {
    const category = parseCategoryFromTags(row?.tags);
    if (category === "promise_resolved") resolvedByCategory.add("promise");
    if (category === "apology_resolved") resolvedByCategory.add("apology");
  }

  const rows = (Array.isArray(memoryRows) ? memoryRows : [])
    .map((row) => {
      const content = String(row?.content || "").trim();
      const category = parseCategoryFromTags(row?.tags);
      const unresolvedPriority =
        (category === "promise" || category === "apology") &&
        !resolvedByCategory.has(category) &&
        content.length > 0 &&
        !appearsResolved(content);
      return {
        content,
        category,
        unresolvedPriority
      };
    })
    .filter((row) => row.content.length > 0);

  const priority = rows.filter((row) => row.unresolvedPriority);
  const rest = rows.filter((row) => !row.unresolvedPriority);
  const ordered = [...priority, ...rest];

  const recentPlayerMemories = [];
  const seen = new Set();
  for (const row of ordered) {
    if (seen.has(row.content)) continue;
    seen.add(row.content);
    recentPlayerMemories.push(row.content);
    if (recentPlayerMemories.length >= Math.max(0, maxCount)) break;
  }

  const prioritizedThreads = [];
  for (const row of priority) {
    if (prioritizedThreads.includes(row.content)) continue;
    prioritizedThreads.push(row.content);
    if (prioritizedThreads.length >= 2) break;
  }

  const unresolvedCategories = [...new Set(priority.map((row) => row.category).filter(Boolean))];

  return {
    recentPlayerMemories,
    prioritizedThreads,
    unresolvedCategories
  };
}

export async function getOrCreateDailyFollowupHint({
  cache,
  dayNumber,
  npc,
  player,
  getMemoriesByTag,
  generateFollowup,
  worldContext,
  townLog
}) {
  const key = makeFollowupCacheKey({
    dayNumber,
    npcId: npc?.id,
    playerId: player?.playerId
  });
  if (!key) return "";
  if (cache?.has(key)) {
    return cache.get(key) || "";
  }
  const memories = await getMemoriesByTag(npc.id, `player:${player.playerId}`, 6);
  const { recentPlayerMemories, prioritizedThreads } = buildFollowupMemoryContext(memories, 4);
  const hint = await generateFollowup({
    npc,
    playerName: player?.name || "Traveler",
    worldContext,
    recentPlayerMemories,
    prioritizedThreads,
    townLog: Array.isArray(townLog) ? townLog : []
  });
  const clean = String(hint || "").trim().slice(0, 140);
  cache?.set(key, clean);
  return clean;
}
