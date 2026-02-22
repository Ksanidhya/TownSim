import test from "node:test";
import assert from "node:assert/strict";
import {
  MISSION_CHAIN,
  applyMissionEvent,
  createWorldState,
  ensurePlayerMissionProgress,
  setEconomyState,
  setPlayerDynamicMission,
  setWorldEvents
} from "../src/world.js";

test("base mission chain advances to next mission", () => {
  const player = { playerId: "p1", missionProgress: null };
  ensurePlayerMissionProgress(player);
  const first = MISSION_CHAIN[0];
  const event = {
    type: "move",
    x: first.targetX,
    y: first.targetY,
    areaName: "Forest"
  };
  const res = applyMissionEvent(player, event);
  assert.equal(res.changed, true);
  assert.equal(res.completedMission?.id, first.id);
  assert.equal(player.missionProgress.index, 1);
  assert.equal(res.nextMission?.id, MISSION_CHAIN[1].id);
});

test("dynamic mission completes and clears active dynamic mission", () => {
  const player = { playerId: "p2", missionProgress: null };
  ensurePlayerMissionProgress(player);
  player.missionProgress.index = MISSION_CHAIN.length;
  setPlayerDynamicMission(player, {
    objectiveType: "talk_unique_npcs",
    targetCount: 2
  });
  const r1 = applyMissionEvent(player, { type: "talk_npc", npcId: "npc_guard" });
  const r2 = applyMissionEvent(player, { type: "talk_npc", npcId: "npc_artist" });
  assert.equal(r1.changed, true);
  assert.equal(r2.changed, true);
  assert.equal(player.missionProgress.dynamicMission, null);
  assert.equal(player.missionProgress.dynamicCompleted, 1);
});

test("world event severity and economy reward multipliers are clamped", () => {
  const world = createWorldState();
  setWorldEvents(world, {
    active: [{ title: "Crisis", description: "test", severity: 9, area: "Dock", effect: "guard_alert" }]
  });
  assert.equal(world.worldEvents.active[0].severity, 2);

  setEconomyState(world, { missionRewardMultiplier: 99 });
  assert.equal(world.economy.missionRewardMultiplier, 1.35);
  setEconomyState(world, { missionRewardMultiplier: 0.01 });
  assert.equal(world.economy.missionRewardMultiplier, 0.75);
});
