import test from "node:test";
import assert from "node:assert/strict";
import {
  buildFollowupMemoryContext,
  compactMemoryLines,
  composeContinuityHint,
  getOrCreateDailyFollowupHint,
  makeFollowupCacheKey
} from "../src/followup.js";

test("makeFollowupCacheKey builds stable key", () => {
  const key = makeFollowupCacheKey({
    dayNumber: 3,
    npcId: "npc_guard",
    playerId: "player_1"
  });
  assert.equal(key, "3:player_1:npc_guard");
});

test("makeFollowupCacheKey rejects missing identifiers", () => {
  assert.equal(makeFollowupCacheKey({ dayNumber: 1, npcId: "", playerId: "p1" }), "");
  assert.equal(makeFollowupCacheKey({ dayNumber: 1, npcId: "n1", playerId: "" }), "");
  assert.equal(makeFollowupCacheKey({ dayNumber: 0, npcId: "n1", playerId: "p1" }), "");
});

test("compactMemoryLines keeps non-empty content in order", () => {
  const out = compactMemoryLines(
    [{ content: "  first  " }, { content: "" }, { content: "second" }, { foo: "ignored" }],
    4
  );
  assert.deepEqual(out, ["first", "second"]);
});

test("composeContinuityHint combines followup and memories", () => {
  const out = composeContinuityHint({
    followup: "ask about the promised lantern map",
    memoryLines: ["Player promised to return tomorrow.", "Shared tea at dusk."]
  });
  assert.match(out, /^next-day follow-up: ask about the promised lantern map \| /);
  assert.match(out, /Player promised to return tomorrow\./);
  assert.match(out, /Shared tea at dusk\./);
});

test("composeContinuityHint returns none when empty", () => {
  assert.equal(composeContinuityHint({ followup: "", memoryLines: [] }), "none");
});

test("getOrCreateDailyFollowupHint uses cache for repeated requests", async () => {
  const cache = new Map();
  let memoryCalls = 0;
  let followupCalls = 0;

  const deps = {
    cache,
    dayNumber: 7,
    npc: { id: "npc_guard", role: "Town Guard" },
    player: { playerId: "player_1", name: "Ari" },
    getMemoriesByTag: async () => {
      memoryCalls += 1;
      return [{ content: "Player promised patrol notes." }];
    },
    generateFollowup: async ({ recentPlayerMemories }) => {
      followupCalls += 1;
      assert.deepEqual(recentPlayerMemories, ["Player promised patrol notes."]);
      return "check if Ari kept that patrol promise";
    },
    worldContext: { dayNumber: 7, timeLabel: "8:00 AM", weather: "clear", rumorOfTheDay: "none" },
    townLog: ["Guard alert near dock"]
  };

  const first = await getOrCreateDailyFollowupHint(deps);
  const second = await getOrCreateDailyFollowupHint(deps);

  assert.equal(first, "check if Ari kept that patrol promise");
  assert.equal(second, first);
  assert.equal(memoryCalls, 1);
  assert.equal(followupCalls, 1);
});

test("getOrCreateDailyFollowupHint refreshes across day boundary", async () => {
  const cache = new Map();
  let calls = 0;
  const base = {
    cache,
    npc: { id: "npc_artist", role: "Artist" },
    player: { playerId: "player_2", name: "Mina" },
    getMemoriesByTag: async () => [{ content: "Spoke about colors at market." }],
    generateFollowup: async () => {
      calls += 1;
      return `hint-${calls}`;
    },
    worldContext: { dayNumber: 1, timeLabel: "9:00 AM", weather: "clear", rumorOfTheDay: "none" },
    townLog: []
  };

  const day1 = await getOrCreateDailyFollowupHint({ ...base, dayNumber: 1 });
  const day2 = await getOrCreateDailyFollowupHint({ ...base, dayNumber: 2 });

  assert.equal(day1, "hint-1");
  assert.equal(day2, "hint-2");
  assert.equal(calls, 2);
});

test("buildFollowupMemoryContext prioritizes unresolved promises/apologies", () => {
  const ctx = buildFollowupMemoryContext(
    [
      { content: "General small talk at the dock.", tags: "player:p1,category:request" },
      { content: "Player promised to bring herbs tomorrow.", tags: "player:p1,category:promise" },
      { content: "Player apologized for snapping earlier.", tags: "player:p1,category:apology" }
    ],
    4
  );
  assert.deepEqual(ctx.prioritizedThreads, [
    "Player promised to bring herbs tomorrow.",
    "Player apologized for snapping earlier."
  ]);
  assert.deepEqual(ctx.unresolvedCategories.sort(), ["apology", "promise"]);
  assert.deepEqual(ctx.recentPlayerMemories.slice(0, 2), [
    "Player promised to bring herbs tomorrow.",
    "Player apologized for snapping earlier."
  ]);
});

test("buildFollowupMemoryContext de-prioritizes resolved promise/apology text", () => {
  const ctx = buildFollowupMemoryContext(
    [
      { content: "Promise kept and resolved before dawn.", tags: "player:p1,category:promise" },
      { content: "Apology accepted by the guard.", tags: "player:p1,category:apology" },
      { content: "Player asked about fish prices.", tags: "player:p1,category:request" }
    ],
    4
  );
  assert.deepEqual(ctx.prioritizedThreads, []);
  assert.equal(ctx.recentPlayerMemories[0], "Promise kept and resolved before dawn.");
});

test("buildFollowupMemoryContext honors explicit resolved category tags", () => {
  const ctx = buildFollowupMemoryContext(
    [
      { content: "Player promised to share a map.", tags: "player:p1,category:promise" },
      { content: "Promise resolved by delivery.", tags: "player:p1,category:promise_resolved" }
    ],
    4
  );
  assert.deepEqual(ctx.prioritizedThreads, []);
  assert.deepEqual(ctx.unresolvedCategories, []);
});

test("getOrCreateDailyFollowupHint passes prioritized unresolved threads to generator", async () => {
  const cache = new Map();
  let seenPrioritized = [];
  await getOrCreateDailyFollowupHint({
    cache,
    dayNumber: 5,
    npc: { id: "npc_devotee", role: "Religious Devotee" },
    player: { playerId: "p7", name: "Rin" },
    getMemoriesByTag: async () => [
      { content: "Player asked about candles.", tags: "player:p7,category:request" },
      { content: "Player promised to return by sunrise.", tags: "player:p7,category:promise" }
    ],
    generateFollowup: async ({ prioritizedThreads }) => {
      seenPrioritized = prioritizedThreads;
      return "ask if Rin kept the sunrise promise";
    },
    worldContext: { dayNumber: 5, timeLabel: "7:00 AM", weather: "clear", rumorOfTheDay: "none" },
    townLog: []
  });
  assert.deepEqual(seenPrioritized, ["Player promised to return by sunrise."]);
});
