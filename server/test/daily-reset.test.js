import test from "node:test";
import assert from "node:assert/strict";
import { runDailyRefreshPipeline } from "../src/daily-reset.js";

test("runDailyRefreshPipeline clears caches and runs all steps", async () => {
  const order = [];
  let clears = 0;
  await runDailyRefreshPipeline({
    clearCaches: () => {
      clears += 1;
      order.push("clear");
    },
    shouldRefreshStoryArc: true,
    refreshStoryArc: async () => order.push("story"),
    refreshTownMission: async () => order.push("town"),
    refreshRoutineNudges: async () => order.push("routine"),
    refreshEconomy: async () => order.push("economy"),
    refreshWorldEvents: async () => order.push("events"),
    refreshFactionPulse: async () => order.push("factions"),
    refreshReactiveMissions: async () => order.push("reactive"),
    onStepDone: () => order.push("tick")
  });

  assert.equal(clears, 1);
  assert.equal(order[0], "clear");
  assert.match(order.join(","), /story/);
  assert.match(order.join(","), /reactive/);
  assert.equal(order.filter((x) => x === "tick").length, 7);
});

test("runDailyRefreshPipeline skips story refresh when not needed", async () => {
  let storyCalls = 0;
  await runDailyRefreshPipeline({
    clearCaches: () => {},
    shouldRefreshStoryArc: false,
    refreshStoryArc: async () => {
      storyCalls += 1;
    },
    refreshTownMission: async () => {},
    refreshRoutineNudges: async () => {},
    refreshEconomy: async () => {},
    refreshWorldEvents: async () => {},
    refreshFactionPulse: async () => {},
    refreshReactiveMissions: async () => {},
    onStepDone: () => {}
  });
  assert.equal(storyCalls, 0);
});
