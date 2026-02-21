import { AREAS, NPC_SEEDS, WORLD_HEIGHT, WORLD_WIDTH } from "./constants.js";

function clamp(val, min, max) {
  return Math.max(min, Math.min(max, val));
}

const HOME_ANCHOR = { x: 680, y: 220 };
const FARM_ORIGIN = { x: 600, y: 250 };
const FARM_COLS = 3;
const FARM_ROWS = 3;
const FARM_GAP = 42;

export const CROP_CONFIG = {
  turnip: { label: "Turnip", growMinutes: 180, seedCost: 6, minYield: 1, maxYield: 2, sellPrice: 8 },
  carrot: { label: "Carrot", growMinutes: 240, seedCost: 8, minYield: 1, maxYield: 3, sellPrice: 10 },
  pumpkin: { label: "Pumpkin", growMinutes: 360, seedCost: 12, minYield: 1, maxYield: 2, sellPrice: 18 }
};

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

export function createPlayerFarmIfMissing(state, socketId) {
  if (!state.farms.has(socketId)) {
    state.farms.set(socketId, createPlayerFarm());
  }
  return state.farms.get(socketId);
}

export function removePlayerFarm(state, socketId) {
  state.farms.delete(socketId);
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

export function applyFarmAction({ state, socketId, action, plotId, cropType }) {
  const farm = state.farms.get(socketId);
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

export function createWorldState() {
  const npcs = NPC_SEEDS.map((seed) => ({
    ...seed,
    vx: 0,
    vy: 0,
    speed: 18 + Math.random() * 10,
    talkCooldownUntil: 0
  }));

  return {
    startedAt: Date.now(),
    timeMinutes: 8 * 60,
    weather: "clear",
    rumorOfTheDay: "A hidden lantern was seen near the forest shrine.",
    npcs,
    players: new Map(),
    farms: new Map()
  };
}

export function tickClock(state, deltaMinutes = 8) {
  state.timeMinutes = (state.timeMinutes + deltaMinutes) % (24 * 60);
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
  for (const npc of state.npcs) {
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
  const farm = socketId ? state.farms.get(socketId) || null : null;

  return {
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
