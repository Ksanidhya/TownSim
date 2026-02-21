import { AREAS, NPC_SEEDS, WORLD_HEIGHT, WORLD_WIDTH } from "./constants.js";

function clamp(val, min, max) {
  return Math.max(min, Math.min(max, val));
}

const HOME_ANCHOR = { x: 680, y: 220 };
const FARM_ORIGIN = { x: 600, y: 250 };
const FARM_COLS = 3;
const FARM_ROWS = 3;
const FARM_GAP = 42;
const NPC_PLAYER_HOLD_DISTANCE = 70;
const NPC_PLAYER_HOLD_MS = 5000;
const DAY_BOUNDARY_MINUTES = 6 * 60;
const FOREST_SHRINE = { x: 250, y: 930, radius: 90 };

export const CROP_CONFIG = {
  turnip: { label: "Turnip", growMinutes: 180, seedCost: 6, minYield: 1, maxYield: 2, sellPrice: 8 },
  carrot: { label: "Carrot", growMinutes: 240, seedCost: 8, minYield: 1, maxYield: 3, sellPrice: 10 },
  pumpkin: { label: "Pumpkin", growMinutes: 360, seedCost: 12, minYield: 1, maxYield: 2, sellPrice: 18 }
};

export const MISSION_CHAIN = [
  {
    id: "hidden_lantern",
    title: "Hidden Lantern",
    description: "Search the forest shrine and find the rumored lantern."
  },
  {
    id: "meet_guard",
    title: "Meet The Guard",
    description: "Talk to Rook in Town Square."
  },
  {
    id: "first_harvest",
    title: "First Harvest",
    description: "Harvest 2 crops from your home field.",
    targetCount: 2
  },
  {
    id: "know_the_town",
    title: "Know The Town",
    description: "Speak to 3 different townsfolk.",
    targetCount: 3
  }
];

const TOWN_MISSION_TEMPLATES = [
  {
    title: "Market Chatter",
    description: "People are whispering near the stalls. Hear a few voices.",
    objectiveType: "talk_to_any_npc",
    targetCount: 2
  },
  {
    title: "Square Watch",
    description: "Something feels tense in Town Square. Stop by and check it out.",
    objectiveType: "visit_area",
    targetArea: "Town Square",
    targetCount: 1
  },
  {
    title: "Harbor Mood",
    description: "Dock workers are restless. Visit the Dock and ask around.",
    objectiveType: "visit_area",
    targetArea: "Dock",
    targetCount: 1
  },
  {
    title: "Guard Briefing",
    description: "The guard is collecting stories from townsfolk. Talk to Rook.",
    objectiveType: "talk_to_role",
    targetRole: "Town Guard",
    targetCount: 1
  },
  {
    title: "Fresh Produce",
    description: "Town wants fresh food. Bring in a small harvest.",
    objectiveType: "harvest_any",
    targetCount: 1
  }
];

function clampMissionIndex(index) {
  const max = MISSION_CHAIN.length;
  return Math.max(0, Math.min(max, Number(index) || 0));
}

export function createMissionProgress() {
  return {
    index: 0,
    harvestCount: 0,
    spokenNpcIds: [],
    townMission: {
      missionId: "",
      count: 0,
      visitedAreas: [],
      talkedNpcIds: [],
      talkedRoles: []
    }
  };
}

export function ensurePlayerMissionProgress(player) {
  if (!player.missionProgress) {
    player.missionProgress = createMissionProgress();
  }
  player.missionProgress.index = clampMissionIndex(player.missionProgress.index);
  if (!Array.isArray(player.missionProgress.spokenNpcIds)) {
    player.missionProgress.spokenNpcIds = [];
  }
  if (!Number.isFinite(player.missionProgress.harvestCount)) {
    player.missionProgress.harvestCount = 0;
  }
  if (!player.missionProgress.townMission || typeof player.missionProgress.townMission !== "object") {
    player.missionProgress.townMission = {
      missionId: "",
      count: 0,
      visitedAreas: [],
      talkedNpcIds: [],
      talkedRoles: []
    };
  }
  const tm = player.missionProgress.townMission;
  if (!Number.isFinite(tm.count)) tm.count = 0;
  if (!Array.isArray(tm.visitedAreas)) tm.visitedAreas = [];
  if (!Array.isArray(tm.talkedNpcIds)) tm.talkedNpcIds = [];
  if (!Array.isArray(tm.talkedRoles)) tm.talkedRoles = [];
  return player.missionProgress;
}

function fallbackTownMission(state) {
  const idx = Math.max(0, (state.dayNumber - 1) % TOWN_MISSION_TEMPLATES.length);
  const template = TOWN_MISSION_TEMPLATES[idx];
  return {
    id: `town_${state.dayNumber}_${template.objectiveType.toLowerCase()}`,
    source: "fallback",
    title: template.title,
    description: template.description,
    objectiveType: template.objectiveType,
    targetArea: template.targetArea || null,
    targetRole: template.targetRole || null,
    targetCount: Math.max(1, Number(template.targetCount) || 1),
    gossip: state.rumorOfTheDay || "The town is restless today."
  };
}

export function setTownMission(state, mission) {
  const safe = mission && typeof mission === "object" ? mission : {};
  const objectiveType = String(safe.objectiveType || "").trim().toLowerCase();
  const allowed = new Set(["visit_area", "talk_to_any_npc", "talk_to_role", "harvest_any"]);
  if (!allowed.has(objectiveType)) {
    state.townMission = fallbackTownMission(state);
    return state.townMission;
  }

  const targetCount = Math.max(1, Number(safe.targetCount) || 1);
  state.townMission = {
    id: String(safe.id || `town_${state.dayNumber}_${Date.now()}`),
    source: String(safe.source || "ai"),
    title: String(safe.title || "Town Request").slice(0, 60),
    description: String(safe.description || "Help around town based on today's chatter.").slice(0, 180),
    objectiveType,
    targetArea: safe.targetArea ? String(safe.targetArea).slice(0, 40) : null,
    targetRole: safe.targetRole ? String(safe.targetRole).slice(0, 40) : null,
    targetCount,
    gossip: String(safe.gossip || state.rumorOfTheDay || "").slice(0, 180)
  };
  return state.townMission;
}

function activeTownMission(state) {
  if (!state.townMission) {
    state.townMission = fallbackTownMission(state);
  }
  return state.townMission;
}

function townMissionProgressText(state, player) {
  const mission = activeTownMission(state);
  const progress = ensurePlayerMissionProgress(player).townMission;
  const done = Math.min(progress.count, mission.targetCount || 1);
  return `${done}/${mission.targetCount || 1}`;
}

export function applyTownMissionEvent(state, player, event) {
  if (!state || !player || !event) return { changed: false };
  const mission = activeTownMission(state);
  const progress = ensurePlayerMissionProgress(player).townMission;
  if (progress.missionId !== mission.id) {
    progress.missionId = mission.id;
    progress.count = 0;
    progress.visitedAreas = [];
    progress.talkedNpcIds = [];
    progress.talkedRoles = [];
  }

  const countBefore = progress.count;
  if (mission.objectiveType === "visit_area" && event.type === "move") {
    const areaName = String(event.areaName || "").trim();
    if (areaName && areaName === mission.targetArea && !progress.visitedAreas.includes(areaName)) {
      progress.visitedAreas.push(areaName);
      progress.count += 1;
    }
  }
  if (mission.objectiveType === "talk_to_any_npc" && event.type === "talk_npc") {
    const npcId = String(event.npcId || "").trim();
    if (npcId && !progress.talkedNpcIds.includes(npcId)) {
      progress.talkedNpcIds.push(npcId);
      progress.count += 1;
    }
  }
  if (mission.objectiveType === "talk_to_role" && event.type === "talk_npc_role") {
    const role = String(event.role || "").trim();
    if (role && role === mission.targetRole) {
      progress.count += 1;
    }
  }
  if (mission.objectiveType === "harvest_any" && event.type === "harvest_success") {
    progress.count += 1;
  }

  const changed = progress.count !== countBefore;
  const completed = progress.count >= (mission.targetCount || 1);
  return {
    changed,
    completed,
    mission,
    progress: townMissionProgressText(state, player)
  };
}

function currentMission(player) {
  const progress = ensurePlayerMissionProgress(player);
  if (progress.index >= MISSION_CHAIN.length) return null;
  return MISSION_CHAIN[progress.index];
}

function missionProgressText(player) {
  const progress = ensurePlayerMissionProgress(player);
  const mission = currentMission(player);
  if (!mission) return "All missions complete.";

  if (mission.id === "hidden_lantern") {
    return "Go to the forest shrine.";
  }
  if (mission.id === "meet_guard") {
    return "Find and talk to Rook.";
  }
  if (mission.id === "first_harvest") {
    const done = Math.min(mission.targetCount || 2, progress.harvestCount);
    return `Harvest progress: ${done}/${mission.targetCount || 2}.`;
  }
  if (mission.id === "know_the_town") {
    const done = Math.min(mission.targetCount || 3, progress.spokenNpcIds.length);
    return `People met: ${done}/${mission.targetCount || 3}.`;
  }
  return "Keep exploring town.";
}

function advanceMission(player) {
  const progress = ensurePlayerMissionProgress(player);
  const mission = currentMission(player);
  if (!mission) return null;

  progress.index += 1;
  if (mission.id === "first_harvest") {
    progress.harvestCount = 0;
  }
  if (mission.id === "know_the_town") {
    progress.spokenNpcIds = [];
  }
  const next = currentMission(player);
  return { completed: mission, next };
}

export function applyMissionEvent(player, event) {
  if (!player) return { changed: false };
  const progress = ensurePlayerMissionProgress(player);
  const mission = currentMission(player);
  if (!mission) return { changed: false };

  if (mission.id === "hidden_lantern" && event?.type === "move") {
    const x = Number(event?.x);
    const y = Number(event?.y);
    if (Number.isFinite(x) && Number.isFinite(y) && Math.hypot(x - FOREST_SHRINE.x, y - FOREST_SHRINE.y) <= FOREST_SHRINE.radius) {
      const result = advanceMission(player);
      return {
        changed: true,
        completedMission: result?.completed || null,
        nextMission: result?.next || null
      };
    }
  }

  if (mission.id === "meet_guard" && event?.type === "talk_npc" && event?.npcId === "npc_guard") {
    const result = advanceMission(player);
    return {
      changed: true,
      completedMission: result?.completed || null,
      nextMission: result?.next || null
    };
  }

  if (mission.id === "first_harvest" && event?.type === "harvest_success") {
    progress.harvestCount += 1;
    const done = progress.harvestCount >= (mission.targetCount || 2);
    if (done) {
      const result = advanceMission(player);
      return {
        changed: true,
        completedMission: result?.completed || null,
        nextMission: result?.next || null
      };
    }
    return { changed: true };
  }

  if (mission.id === "know_the_town" && event?.type === "talk_npc") {
    const npcId = String(event?.npcId || "").trim();
    if (!npcId) return { changed: false };
    if (!progress.spokenNpcIds.includes(npcId)) {
      progress.spokenNpcIds.push(npcId);
      const done = progress.spokenNpcIds.length >= (mission.targetCount || 3);
      if (done) {
        const result = advanceMission(player);
        return {
          changed: true,
          completedMission: result?.completed || null,
          nextMission: result?.next || null
        };
      }
      return { changed: true };
    }
  }

  return { changed: false };
}

function missionSnapshot(player) {
  const progress = ensurePlayerMissionProgress(player);
  const mission = currentMission(player);
  if (!mission) {
    return {
      completed: true,
      title: "All Missions Complete",
      description: "No active missions right now.",
      progress: "Great work. More missions soon.",
      step: MISSION_CHAIN.length,
      total: MISSION_CHAIN.length
    };
  }
  return {
    id: mission.id,
    completed: false,
    title: mission.title,
    description: mission.description,
    progress: missionProgressText(player),
    step: progress.index + 1,
    total: MISSION_CHAIN.length
  };
}

function townMissionSnapshot(state, player) {
  const mission = activeTownMission(state);
  const progress = ensurePlayerMissionProgress(player).townMission;
  if (progress.missionId !== mission.id) {
    progress.missionId = mission.id;
    progress.count = 0;
    progress.visitedAreas = [];
    progress.talkedNpcIds = [];
    progress.talkedRoles = [];
  }
  const count = Math.min(progress.count, mission.targetCount || 1);
  const target = mission.targetCount || 1;
  return {
    id: mission.id,
    title: mission.title,
    description: mission.description,
    gossip: mission.gossip || "",
    objectiveType: mission.objectiveType,
    progress: `${count}/${target}`,
    completed: count >= target
  };
}

function createPlot(col, row) {
  const id = row * FARM_COLS + col + 1;
  return {
    id,
    x: FARM_ORIGIN.x + col * FARM_GAP,
    y: FARM_ORIGIN.y + row * FARM_GAP,
    state: "empty",
    cropType: null,
    growth: 0,
    water: 0,
    wateredAt: null
  };
}

function createPlayerFarm() {
  const plots = [];
  for (let row = 0; row < FARM_ROWS; row += 1) {
    for (let col = 0; col < FARM_COLS; col += 1) {
      plots.push(createPlot(col, row));
    }
  }

  return {
    home: { ...HOME_ANCHOR },
    plots,
    inventory: {
      turnip_seed: 6,
      carrot_seed: 5,
      pumpkin_seed: 3,
      turnip: 0,
      carrot: 0,
      pumpkin: 0
    },
    coins: 40
  };
}

function findPlotById(farm, plotId) {
  const numericId = Number(plotId);
  if (!Number.isFinite(numericId)) return null;
  return farm.plots.find((p) => p.id === numericId) || null;
}

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

export function createPlayerFarmIfMissing(state, ownerId) {
  if (!state.farms.has(ownerId)) {
    state.farms.set(ownerId, createPlayerFarm());
  }
  return state.farms.get(ownerId);
}

export function removePlayerFarm(state, ownerId) {
  state.farms.delete(ownerId);
}

export function tickFarmGrowth(state, deltaMinutes = 8) {
  for (const farm of state.farms.values()) {
    for (const plot of farm.plots) {
      if (plot.state === "empty" || plot.state === "ready" || !plot.cropType) continue;
      const crop = CROP_CONFIG[plot.cropType];
      if (!crop) continue;

      plot.water = clamp(plot.water - deltaMinutes * 0.2, 0, 100);
      const growthFactor = 0.3 + (plot.water / 100) * 0.7;
      plot.growth = clamp(plot.growth + deltaMinutes * growthFactor, 0, crop.growMinutes);

      if (plot.growth >= crop.growMinutes) {
        plot.state = "ready";
      } else {
        plot.state = "growing";
      }
    }
  }
}

export function applyFarmAction({ state, ownerId, action, plotId, cropType }) {
  const farm = state.farms.get(ownerId);
  if (!farm) {
    return { ok: false, message: "Farm not found." };
  }

  const plot = findPlotById(farm, plotId);
  if (!plot) {
    return { ok: false, message: "Select a valid plot first." };
  }

  if (action === "sow") {
    const crop = CROP_CONFIG[cropType];
    if (!crop) return { ok: false, message: "Unknown crop type." };
    if (plot.state !== "empty") return { ok: false, message: "That plot is already in use." };

    const seedKey = `${cropType}_seed`;
    if ((farm.inventory[seedKey] || 0) <= 0) {
      if (farm.coins < crop.seedCost) {
        return { ok: false, message: `Need ${crop.seedCost} coins or spare ${crop.label} seed.` };
      }
      farm.coins -= crop.seedCost;
    } else {
      farm.inventory[seedKey] -= 1;
    }

    plot.state = "seeded";
    plot.cropType = cropType;
    plot.growth = 0;
    plot.water = 35;
    plot.wateredAt = Date.now();
    return { ok: true, message: `${crop.label} seeds sown in plot ${plot.id}.` };
  }

  if (action === "water") {
    if (plot.state === "empty") return { ok: false, message: "This plot has no crop yet." };
    if (plot.state === "ready") return { ok: false, message: "Crop is ready. Harvest it." };

    plot.water = clamp(plot.water + 55, 0, 100);
    plot.state = "growing";
    plot.wateredAt = Date.now();
    return { ok: true, message: `Watered plot ${plot.id}.` };
  }

  if (action === "harvest") {
    if (plot.state !== "ready" || !plot.cropType) return { ok: false, message: "Nothing ready to harvest." };

    const crop = CROP_CONFIG[plot.cropType];
    const yieldCount = randomInt(crop.minYield, crop.maxYield);
    farm.inventory[plot.cropType] = (farm.inventory[plot.cropType] || 0) + yieldCount;
    farm.coins += yieldCount * crop.sellPrice;

    const harvestedCropLabel = crop.label;
    plot.state = "empty";
    plot.cropType = null;
    plot.growth = 0;
    plot.water = 0;
    plot.wateredAt = null;

    return {
      ok: true,
      message: `Harvested ${yieldCount} ${harvestedCropLabel}${yieldCount > 1 ? "s" : ""}.`
    };
  }

  return { ok: false, message: "Unsupported farm action." };
}

function findArea(x, y) {
  return (
    AREAS.find((a) => x >= a.x && x <= a.x + a.w && y >= a.y && y <= a.y + a.h) ||
    AREAS[0]
  );
}

export function areaNameAt(x, y) {
  return findArea(x, y).name;
}

export function createWorldState() {
  const npcs = NPC_SEEDS.map((seed) => ({
    ...seed,
    vx: 0,
    vy: 0,
    speed: 18 + Math.random() * 10,
    talkCooldownUntil: 0,
    holdUntil: 0,
    playerNearby: false,
    tasks: [],
    moveControl: null
  }));

  return {
    startedAt: Date.now(),
    dayNumber: 1,
    timeMinutes: 8 * 60,
    weather: "clear",
    rumorOfTheDay: "A hidden lantern was seen near the forest shrine.",
    dailyTownLog: [],
    yesterdayTownLog: [],
    townMission: fallbackTownMission({ dayNumber: 1, rumorOfTheDay: "A hidden lantern was seen near the forest shrine." }),
    npcs,
    players: new Map(),
    farms: new Map()
  };
}

export function tickClock(state, deltaMinutes = 8) {
  const totalMinutes = 24 * 60;
  const prev = ((state.timeMinutes % totalMinutes) + totalMinutes) % totalMinutes;
  const delta = Math.max(0, Number(deltaMinutes) || 0);
  const rawNext = prev + delta;
  state.timeMinutes = rawNext % totalMinutes;

  const prevBucket = Math.floor((prev - DAY_BOUNDARY_MINUTES) / totalMinutes);
  const nextBucket = Math.floor((rawNext - DAY_BOUNDARY_MINUTES) / totalMinutes);
  const dayTransitions = Math.max(0, nextBucket - prevBucket);
  const dayChanged = dayTransitions > 0;

  if (dayChanged) {
    state.dayNumber += dayTransitions;
    state.yesterdayTownLog = state.dailyTownLog.slice(-24);
    state.dailyTownLog = [];
  }
  return { dayChanged, dayTransitions };
}

export function timeLabel(minutes) {
  const h24 = Math.floor(minutes / 60);
  const mins = minutes % 60;
  const suffix = h24 >= 12 ? "PM" : "AM";
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${h12}:${String(mins).padStart(2, "0")} ${suffix}`;
}

function pickWanderTarget(area) {
  return {
    x: area.x + 16 + Math.random() * (area.w - 32),
    y: area.y + 16 + Math.random() * (area.h - 32)
  };
}

export function tickNpcMovement(state, dtSeconds = 1) {
  const awakePlayers = [...state.players.values()].filter((p) => !p.sleeping);
  const now = Date.now();
  const playerByPlayerId = new Map(awakePlayers.map((p) => [p.playerId, p]));

  for (const npc of state.npcs) {
    const nearPlayer = awakePlayers.some(
      (player) => Math.hypot(npc.x - player.x, npc.y - player.y) <= NPC_PLAYER_HOLD_DISTANCE
    );
    if (nearPlayer && !npc.playerNearby) {
      npc.holdUntil = now + NPC_PLAYER_HOLD_MS;
    }
    npc.playerNearby = nearPlayer;

    const control = npc.moveControl || null;
    if (control && Number.isFinite(control.untilMinutes)) {
      const untilDay = Number.isFinite(control.untilDay) ? control.untilDay : state.dayNumber;
      const expired =
        state.dayNumber > untilDay ||
        (state.dayNumber === untilDay && state.timeMinutes >= control.untilMinutes);
      if (expired) {
        npc.moveControl = null;
      }
    }

    const controlMode = npc.moveControl?.mode || "";
    if (controlMode === "follow_player") {
      const leader = playerByPlayerId.get(npc.moveControl?.playerId);
      if (leader) {
        npc.target = {
          x: clamp(leader.x + (Math.random() * 36 - 18), 0, WORLD_WIDTH),
          y: clamp(leader.y + (Math.random() * 36 - 18), 0, WORLD_HEIGHT)
        };
      }
    } else if (controlMode === "keep_distance") {
      const leader = playerByPlayerId.get(npc.moveControl?.playerId);
      const preferred = Number.isFinite(npc.moveControl?.distance) ? npc.moveControl.distance : 110;
      if (leader) {
        const dx = npc.x - leader.x;
        const dy = npc.y - leader.y;
        const dist = Math.hypot(dx, dy);
        if (dist < preferred - 10 || dist > preferred + 45) {
          const baseDist = Math.max(1, dist);
          const ux = dx / baseDist;
          const uy = dy / baseDist;
          npc.target = {
            x: clamp(leader.x + ux * preferred + (Math.random() * 24 - 12), 0, WORLD_WIDTH),
            y: clamp(leader.y + uy * preferred + (Math.random() * 24 - 12), 0, WORLD_HEIGHT)
          };
        } else {
          npc.vx = 0;
          npc.vy = 0;
          continue;
        }
      }
    } else if (controlMode === "point") {
      const tx = Number(npc.moveControl?.x);
      const ty = Number(npc.moveControl?.y);
      if (Number.isFinite(tx) && Number.isFinite(ty)) {
        npc.target = { x: tx, y: ty };
      }
    } else if (controlMode === "area") {
      const area = AREAS.find((a) => a.name === npc.moveControl?.areaName);
      if (area) {
        if (npc.moveControl?.patrol) {
          const reachedCurrent = npc.target
            ? Math.hypot((npc.target.x || npc.x) - npc.x, (npc.target.y || npc.y) - npc.y) < 18
            : true;
          if (!npc.target || reachedCurrent || Math.random() < 0.03) {
            npc.target = pickWanderTarget(area);
          }
        } else {
          npc.target = { x: area.x + area.w / 2, y: area.y + area.h / 2 };
        }
      }
    } else if (controlMode === "hold") {
      npc.vx = 0;
      npc.vy = 0;
      continue;
    }

    if (!controlMode && now < npc.holdUntil) {
      npc.vx = 0;
      npc.vy = 0;
      continue;
    }

    if (!npc.target || Math.random() < 0.02) {
      const area = AREAS.find((a) => a.name === npc.area) || findArea(npc.x, npc.y);
      npc.target = pickWanderTarget(area);
    }

    const dx = npc.target.x - npc.x;
    const dy = npc.target.y - npc.y;
    const dist = Math.hypot(dx, dy);
    if (dist < 8) {
      npc.vx = 0;
      npc.vy = 0;
      continue;
    }

    npc.vx = (dx / dist) * npc.speed;
    npc.vy = (dy / dist) * npc.speed;
    npc.x = clamp(npc.x + npc.vx * dtSeconds, 0, WORLD_WIDTH);
    npc.y = clamp(npc.y + npc.vy * dtSeconds, 0, WORLD_HEIGHT);
    npc.area = findArea(npc.x, npc.y).name;
  }
}

export function snapshotWorld(state, socketId = null) {
  const player = socketId ? state.players.get(socketId) || null : null;
  const ownerId = player?.playerId || null;
  const farm = ownerId ? state.farms.get(ownerId) || null : null;

  return {
    dayNumber: state.dayNumber,
    timeMinutes: state.timeMinutes,
    timeLabel: timeLabel(state.timeMinutes),
    weather: state.weather,
    rumorOfTheDay: state.rumorOfTheDay,
    npcs: state.npcs.map((n) => ({
      id: n.id,
      name: n.name,
      role: n.role,
      traits: n.traits,
      x: n.x,
      y: n.y,
      area: n.area
    })),
    you: player
      ? {
          id: player.id,
          playerId: player.playerId,
          name: player.name,
          gender: player.gender,
          x: player.x,
          y: player.y
        }
      : null,
    mission: player ? missionSnapshot(player) : null,
    townMission: player ? townMissionSnapshot(state, player) : null,
    farm: farm
      ? {
          home: farm.home,
          coins: farm.coins,
          inventory: farm.inventory,
          plots: farm.plots.map((p) => ({
            id: p.id,
            x: p.x,
            y: p.y,
            state: p.state,
            cropType: p.cropType,
            growth: p.growth,
            water: p.water
          }))
        }
      : null
  };
}

export function pushTownEvent(state, entry) {
  const text = String(entry || "").trim();
  if (!text) return;
  state.dailyTownLog.push(text);
  if (state.dailyTownLog.length > 80) {
    state.dailyTownLog = state.dailyTownLog.slice(-80);
  }
}

export function findNearbyNpcPairs(npcs, maxDistance = 150) {
  const pairs = [];
  for (let i = 0; i < npcs.length; i += 1) {
    for (let j = i + 1; j < npcs.length; j += 1) {
      const a = npcs[i];
      const b = npcs[j];
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      if (dist <= maxDistance) {
        pairs.push({ a, b, dist });
      }
    }
  }
  return pairs.sort((x, y) => x.dist - y.dist);
}
