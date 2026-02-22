import { AREAS, NPC_SEEDS, WORLD_HEIGHT, WORLD_WIDTH } from "./constants.js";

function clamp(val, min, max) {
  return Math.max(min, Math.min(max, val));
}

function normalizeEntityId(value) {
  return String(value || "").trim();
}

function relationPairKey(aId, bId) {
  const a = normalizeEntityId(aId);
  const b = normalizeEntityId(bId);
  if (!a || !b || a === b) return "";
  return a < b ? `${a}::${b}` : `${b}::${a}`;
}

function unpackRelationKey(key) {
  const [a, b] = String(key || "").split("::");
  if (!a || !b) return null;
  return { a, b };
}

function hashString(value) {
  const text = String(value || "");
  let hash = 0;
  for (let i = 0; i < text.length; i += 1) {
    hash = (hash << 5) - hash + text.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash);
}

function weightedPick(list, seed) {
  if (!Array.isArray(list) || list.length === 0) return null;
  const total = list.reduce((sum, item) => sum + Math.max(1, Number(item.weight) || 1), 0);
  const pick = seed % total;
  let acc = 0;
  for (const item of list) {
    acc += Math.max(1, Number(item.weight) || 1);
    if (pick < acc) return item;
  }
  return list[0];
}

function minutesInRange(minutes, start, end) {
  const mins = ((Number(minutes) || 0) % (24 * 60) + 24 * 60) % (24 * 60);
  const s = ((Number(start) || 0) % (24 * 60) + 24 * 60) % (24 * 60);
  const e = ((Number(end) || 0) % (24 * 60) + 24 * 60) % (24 * 60);
  if (s <= e) return mins >= s && mins < e;
  return mins >= s || mins < e;
}

function weekdayForDay(dayNumber) {
  return Math.max(0, ((Number(dayNumber) || 1) - 1) % 7);
}

function routineTemplateForRole(role) {
  return ROLE_ROUTINE_TEMPLATES[role] || {
    workArea: "Town Square",
    workStart: 9 * 60,
    workEnd: 17 * 60,
    workStyle: "roam",
    afterWorkVenues: [
      { type: "square", areaName: "Town Square", weight: 2 },
      { type: "home", areaName: "Housing", weight: 1 }
    ]
  };
}

function buildNpcCharacterProfile(seed) {
  const template = routineTemplateForRole(seed.role);
  const holidayWeekday = hashString(`holiday:${seed.id}`) % 7;
  return {
    profileVersion: 1,
    role: seed.role,
    traits: Array.isArray(seed.traits) ? seed.traits.slice(0, 6) : [],
    homeArea: "Housing",
    work: {
      areaName: template.workArea,
      startMinutes: template.workStart,
      endMinutes: template.workEnd,
      style: template.workStyle
    },
    afterWorkVenues: template.afterWorkVenues.map((v) => ({
      type: v.type,
      areaName: v.areaName,
      weight: Math.max(1, Number(v.weight) || 1)
    })),
    holidayWeekday,
    holidayLabel: WEEK_DAYS[holidayWeekday]
  };
}

function resolveNpcRoutine(state, npc) {
  const profile = npc.characterProfile;
  if (!profile || !profile.work) return null;

  const weekday = weekdayForDay(state.dayNumber);
  const isHoliday = weekday === profile.holidayWeekday;
  const roleNudge = state?.routineNudges?.[profile.role] || null;
  const shiftMinutes = Number(roleNudge?.shiftMinutes) || 0;
  const minutes = state.timeMinutes;
  const startMinutes = profile.work.startMinutes + shiftMinutes;
  const endMinutes = profile.work.endMinutes + shiftMinutes;
  const inWork = !isHoliday && minutesInRange(minutes, startMinutes, endMinutes);
  const daySeed = hashString(`${npc.id}:${state.dayNumber}:${Math.floor(minutes / 60)}`);

  if (inWork) {
    return {
      phase: "work",
      areaName: profile.work.areaName,
      style: profile.work.style || "roam",
      venueType: "work",
      isHoliday
    };
  }

  const afterWork = (isHoliday && minutes >= 9 * 60 && minutes < 23 * 60) || (minutes >= endMinutes && minutes < 23 * 60);
  if (afterWork && Array.isArray(profile.afterWorkVenues) && profile.afterWorkVenues.length > 0) {
    const venues = profile.afterWorkVenues.slice();
    if (roleNudge?.afterWorkArea && typeof roleNudge.afterWorkArea === "string") {
      venues.unshift({ type: "nudge", areaName: roleNudge.afterWorkArea, weight: 4 });
    }
    const venue = weightedPick(venues, daySeed);
    if (venue) {
      return {
        phase: isHoliday ? "holiday_outing" : "after_work",
        areaName: venue.areaName,
        style: venue.type === "square" ? "roam" : "patrol",
        venueType: venue.type,
        isHoliday
      };
    }
  }

  return {
    phase: isHoliday ? "holiday_rest" : "rest",
    areaName: profile.homeArea || npc.area || "Housing",
    style: "roam",
    venueType: "home",
    isHoliday
  };
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
const WEEK_DAYS = ["Moonday", "Tide", "Windsday", "Thorn", "Firesday", "Starday", "Restday"];

const ROLE_ROUTINE_TEMPLATES = {
  Businessman: {
    workArea: "Market Street",
    workStart: 9 * 60,
    workEnd: 17 * 60,
    workStyle: "trade",
    afterWorkVenues: [
      { type: "market", areaName: "Market Street", weight: 3 },
      { type: "bar", areaName: "Market Street", weight: 2 },
      { type: "square", areaName: "Town Square", weight: 1 }
    ]
  },
  Politician: {
    workArea: "Town Square",
    workStart: 10 * 60,
    workEnd: 16 * 60,
    workStyle: "patrol",
    afterWorkVenues: [
      { type: "square", areaName: "Town Square", weight: 3 },
      { type: "club", areaName: "Market Street", weight: 1 },
      { type: "sanctum", areaName: "Sanctum", weight: 1 }
    ]
  },
  Fisherman: {
    workArea: "Dock",
    workStart: 5 * 60,
    workEnd: 14 * 60,
    workStyle: "patrol",
    afterWorkVenues: [
      { type: "bar", areaName: "Dock", weight: 2 },
      { type: "market", areaName: "Market Street", weight: 1 },
      { type: "home", areaName: "Housing", weight: 1 }
    ]
  },
  "Shop Owner": {
    workArea: "Market Street",
    workStart: 8 * 60,
    workEnd: 18 * 60,
    workStyle: "trade",
    afterWorkVenues: [
      { type: "market", areaName: "Market Street", weight: 3 },
      { type: "square", areaName: "Town Square", weight: 1 },
      { type: "home", areaName: "Housing", weight: 1 }
    ]
  },
  Artist: {
    workArea: "Housing",
    workStart: 10 * 60,
    workEnd: 15 * 60,
    workStyle: "roam",
    afterWorkVenues: [
      { type: "square", areaName: "Town Square", weight: 2 },
      { type: "club", areaName: "Market Street", weight: 1 },
      { type: "forest", areaName: "Forest", weight: 2 }
    ]
  },
  "Religious Devotee": {
    workArea: "Sanctum",
    workStart: 6 * 60,
    workEnd: 14 * 60,
    workStyle: "patrol",
    afterWorkVenues: [
      { type: "sanctum", areaName: "Sanctum", weight: 2 },
      { type: "square", areaName: "Town Square", weight: 1 },
      { type: "home", areaName: "Housing", weight: 1 }
    ]
  },
  Cultist: {
    workArea: "Forest",
    workStart: 17 * 60,
    workEnd: 23 * 60,
    workStyle: "patrol",
    afterWorkVenues: [
      { type: "forest", areaName: "Forest", weight: 3 },
      { type: "club", areaName: "Market Street", weight: 1 },
      { type: "sanctum", areaName: "Sanctum", weight: 1 }
    ]
  },
  "Town Guard": {
    workArea: "Town Square",
    workStart: 7 * 60,
    workEnd: 19 * 60,
    workStyle: "patrol",
    afterWorkVenues: [
      { type: "bar", areaName: "Market Street", weight: 1 },
      { type: "dock", areaName: "Dock", weight: 1 },
      { type: "home", areaName: "Housing", weight: 2 }
    ]
  },
  Herbalist: {
    workArea: "Forest",
    workStart: 6 * 60,
    workEnd: 13 * 60,
    workStyle: "roam",
    afterWorkVenues: [
      { type: "forest", areaName: "Forest", weight: 2 },
      { type: "market", areaName: "Market Street", weight: 1 },
      { type: "home", areaName: "Housing", weight: 1 }
    ]
  },
  Blacksmith: {
    workArea: "Housing",
    workStart: 8 * 60,
    workEnd: 17 * 60,
    workStyle: "trade",
    afterWorkVenues: [
      { type: "bar", areaName: "Market Street", weight: 1 },
      { type: "square", areaName: "Town Square", weight: 1 },
      { type: "home", areaName: "Housing", weight: 2 }
    ]
  }
};
const NPC_ROLES = [...new Set(NPC_SEEDS.map((npc) => String(npc.role || "").trim()).filter(Boolean))];

export const CROP_CONFIG = {
  turnip: { label: "Turnip", growMinutes: 180, seedCost: 6, minYield: 1, maxYield: 2, sellPrice: 8 },
  carrot: { label: "Carrot", growMinutes: 240, seedCost: 8, minYield: 1, maxYield: 3, sellPrice: 10 },
  pumpkin: { label: "Pumpkin", growMinutes: 360, seedCost: 12, minYield: 1, maxYield: 2, sellPrice: 18 }
};
const CROP_TYPES = Object.keys(CROP_CONFIG);

export const MISSION_CHAIN = [
  {
    id: "hidden_lantern",
    title: "Hidden Lantern",
    description: "Search the forest shrine and find the rumored lantern.",
    objectiveType: "reach_point",
    targetX: FOREST_SHRINE.x,
    targetY: FOREST_SHRINE.y,
    targetRadius: FOREST_SHRINE.radius
  },
  {
    id: "meet_guard",
    title: "Meet The Guard",
    description: "Talk to Rook in Town Square.",
    objectiveType: "talk_npc",
    targetNpcId: "npc_guard"
  },
  {
    id: "first_harvest",
    title: "First Harvest",
    description: "Harvest 2 crops from your home field.",
    objectiveType: "harvest_count",
    targetCount: 2
  },
  {
    id: "know_the_town",
    title: "Know The Town",
    description: "Speak to 3 different townsfolk.",
    objectiveType: "talk_unique_npcs",
    targetCount: 3
  },
  {
    id: "dock_visit",
    title: "Harbor Check",
    description: "Visit the Dock.",
    objectiveType: "visit_area",
    targetArea: "Dock"
  },
  {
    id: "market_visit",
    title: "Market Run",
    description: "Visit Market Street.",
    objectiveType: "visit_area",
    targetArea: "Market Street"
  },
  {
    id: "meet_herbalist",
    title: "Find The Herbalist",
    description: "Talk to Mira in the Forest.",
    objectiveType: "talk_npc",
    targetNpcId: "npc_herbalist"
  },
  {
    id: "seasoned_harvest",
    title: "Seasoned Farmer",
    description: "Harvest 4 more crops.",
    objectiveType: "harvest_count",
    targetCount: 4
  },
  {
    id: "talk_roles",
    title: "Across Professions",
    description: "Talk to 3 different roles in town.",
    objectiveType: "talk_unique_roles",
    targetCount: 3
  },
  {
    id: "tour_town",
    title: "Town Tour",
    description: "Visit 3 different main areas.",
    objectiveType: "visit_unique_areas",
    targetCount: 3
  },
  {
    id: "sanctum_visit",
    title: "Sanctum Pilgrimage",
    description: "Visit the Sanctum once.",
    objectiveType: "visit_area",
    targetArea: "Sanctum"
  },
  {
    id: "dock_harvest_combo",
    title: "Harbor Provisioning",
    description: "Harvest 3 crops for dock workers.",
    objectiveType: "harvest_count",
    targetCount: 3
  },
  {
    id: "meet_blacksmith",
    title: "Forge Greeting",
    description: "Talk to Doran the Blacksmith.",
    objectiveType: "talk_npc",
    targetNpcId: "npc_blacksmith"
  },
  {
    id: "meet_devotee",
    title: "Sanctum Counsel",
    description: "Talk to Sister Elen.",
    objectiveType: "talk_npc",
    targetNpcId: "npc_devotee"
  },
  {
    id: "five_faces",
    title: "Five Faces",
    description: "Speak to 5 different townsfolk.",
    objectiveType: "talk_unique_npcs",
    targetCount: 5
  },
  {
    id: "wide_patrol",
    title: "Wide Patrol",
    description: "Visit 4 different town areas.",
    objectiveType: "visit_unique_areas",
    targetCount: 4
  },
  {
    id: "role_mixer",
    title: "Role Mixer",
    description: "Talk to 4 different roles.",
    objectiveType: "talk_unique_roles",
    targetCount: 4
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
    visitedAreas: [],
    spokenRoles: [],
    dynamicCompleted: 0,
    dynamicMission: null,
    townMission: {
      missionId: "",
      count: 0,
      visitedAreas: [],
      talkedNpcIds: [],
      talkedRoles: []
    }
  };
}

function createReputationState() {
  const byRole = {};
  for (const role of NPC_ROLES) {
    byRole[role] = 0;
  }
  return {
    global: 0,
    byRole,
    recent: []
  };
}

export function reputationLabel(score) {
  const s = Number(score) || 0;
  if (s >= 28) return "beloved";
  if (s >= 14) return "trusted";
  if (s >= 4) return "known";
  if (s <= -28) return "notorious";
  if (s <= -14) return "disliked";
  if (s <= -4) return "wary";
  return "neutral";
}

export function ensurePlayerReputation(player) {
  if (!player || typeof player !== "object") return createReputationState();
  if (!player.reputation || typeof player.reputation !== "object") {
    player.reputation = createReputationState();
  }
  if (!Number.isFinite(player.reputation.global)) {
    player.reputation.global = 0;
  }
  if (!player.reputation.byRole || typeof player.reputation.byRole !== "object") {
    player.reputation.byRole = {};
  }
  for (const role of NPC_ROLES) {
    if (!Number.isFinite(player.reputation.byRole[role])) {
      player.reputation.byRole[role] = 0;
    }
  }
  if (!Array.isArray(player.reputation.recent)) {
    player.reputation.recent = [];
  }
  player.reputation.global = clamp(Math.round(player.reputation.global), -100, 100);
  return player.reputation;
}

export function applyPlayerReputationDelta(player, { role = "", delta = 0, reason = "" } = {}) {
  const rep = ensurePlayerReputation(player);
  const d = Math.round(Number(delta) || 0);
  if (!d) return rep;
  rep.global = clamp(rep.global + d, -100, 100);
  const roleKey = String(role || "").trim();
  if (roleKey) {
    if (!Number.isFinite(rep.byRole[roleKey])) {
      rep.byRole[roleKey] = 0;
    }
    rep.byRole[roleKey] = clamp(Math.round(rep.byRole[roleKey] + d), -60, 60);
  }
  rep.recent.push({
    at: Date.now(),
    role: roleKey,
    delta: d,
    reason: String(reason || "").slice(0, 120)
  });
  if (rep.recent.length > 12) {
    rep.recent = rep.recent.slice(-12);
  }
  return rep;
}

export function ensurePlayerMissionProgress(player) {
  ensurePlayerReputation(player);
  if (!player.missionProgress) {
    player.missionProgress = createMissionProgress();
  }
  player.missionProgress.index = clampMissionIndex(player.missionProgress.index);
  if (!Array.isArray(player.missionProgress.spokenNpcIds)) {
    player.missionProgress.spokenNpcIds = [];
  }
  if (!Array.isArray(player.missionProgress.visitedAreas)) {
    player.missionProgress.visitedAreas = [];
  }
  if (!Array.isArray(player.missionProgress.spokenRoles)) {
    player.missionProgress.spokenRoles = [];
  }
  if (!Number.isFinite(player.missionProgress.harvestCount)) {
    player.missionProgress.harvestCount = 0;
  }
  if (!Number.isFinite(player.missionProgress.dynamicCompleted)) {
    player.missionProgress.dynamicCompleted = 0;
  }
  if (!player.missionProgress.dynamicMission || typeof player.missionProgress.dynamicMission !== "object") {
    player.missionProgress.dynamicMission = null;
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

function fallbackStoryArc(state) {
  return {
    id: `arc_${state.dayNumber}_fallback`,
    title: "Town Undercurrents",
    summary: "Small events are shifting how neighbors see each other.",
    stages: [
      "Listen to what different groups are saying.",
      "Cross-check conflicting stories around town.",
      "Help settle the conflict with clear information."
    ],
    stageIndex: 0,
    stageProgress: 0,
    stageTarget: 2,
    completed: false,
    branchOutcome: "",
    updatedAt: Date.now()
  };
}

function fallbackEconomyState(state) {
  const day = Math.max(1, Number(state?.dayNumber) || 1);
  const wave = (day % 5) - 2;
  const cropPrices = {};
  const demand = {};
  for (const cropType of CROP_TYPES) {
    const base = Number(CROP_CONFIG[cropType]?.sellPrice) || 1;
    const offset = cropType === "turnip" ? wave : cropType === "carrot" ? -wave : Math.round(wave * 0.5);
    cropPrices[cropType] = Math.max(1, base + offset);
    demand[cropType] = offset >= 2 ? "high" : offset <= -2 ? "low" : "normal";
  }
  return {
    mood: "steady",
    cropPrices,
    demand,
    missionRewardMultiplier: 1,
    note: "Market is stable today.",
    updatedAt: Date.now()
  };
}

function createRumorState() {
  const byArea = {};
  for (const area of AREAS) {
    byArea[area.name] = 0;
  }
  const byRole = {};
  for (const role of NPC_ROLES) {
    byRole[role] = 0;
  }
  return {
    byArea,
    byRole,
    intensity: 0,
    latestTopics: [],
    updatedAt: Date.now()
  };
}

function fallbackWorldEvents() {
  return {
    active: [],
    updatedAt: Date.now()
  };
}

function fallbackFactionState(npcs = []) {
  const all = Array.isArray(npcs) ? npcs : [];
  const byRole = new Map(all.map((n) => [n.id, n.role]));
  const pickMembers = (roles) => all.filter((n) => roles.includes(byRole.get(n.id))).map((n) => n.id);
  return {
    groups: [
      {
        id: "guild_watch",
        name: "Town Watch",
        goal: "Keep order and contain unrest.",
        members: pickMembers(["Town Guard", "Politician"]),
        influence: 50
      },
      {
        id: "guild_market",
        name: "Market Guild",
        goal: "Protect trade flow and stall profits.",
        members: pickMembers(["Businessman", "Shop Owner", "Blacksmith"]),
        influence: 50
      },
      {
        id: "guild_wilds",
        name: "Wild Circle",
        goal: "Guard forest rites and old paths.",
        members: pickMembers(["Herbalist", "Religious Devotee", "Cultist"]),
        influence: 50
      }
    ],
    tensions: [],
    updatedAt: Date.now()
  };
}

export function setFactionState(state, factionState) {
  if (!state) return null;
  const base = fallbackFactionState(state.npcs || []);
  const src = factionState && typeof factionState === "object" ? factionState : {};
  const groups = Array.isArray(src.groups) ? src.groups : base.groups;
  const tensions = Array.isArray(src.tensions) ? src.tensions : [];
  const prev = activeFactions(state);
  const prevInfluenceById = new Map((prev.groups || []).map((g) => [String(g.id), Number(g.influence) || 50]));
  const prevTensionByPair = new Map(
    (prev.tensions || []).map((t) => [`${String(t.a)}::${String(t.b)}`, Number(t.level) || 0])
  );
  state.factions = {
    groups: groups
      .map((g) => ({
        id: String(g?.id || `f_${Date.now()}`),
        name: String(g?.name || "Faction").slice(0, 40),
        goal: String(g?.goal || "Pursue local interests.").slice(0, 120),
        members: Array.isArray(g?.members) ? g.members.map((m) => String(m)).slice(0, 16) : [],
        influence: (() => {
          const nextRaw = Math.max(20, Math.min(80, Number(g?.influence) || 50));
          const prevVal = prevInfluenceById.get(String(g?.id || "")) ?? 50;
          return Math.round(prevVal * 0.65 + nextRaw * 0.35);
        })()
      }))
      .slice(0, 6),
    tensions: tensions
      .map((t) => ({
        a: String(t?.a || "").slice(0, 40),
        b: String(t?.b || "").slice(0, 40),
        level: (() => {
          const key = `${String(t?.a || "")}::${String(t?.b || "")}`;
          const prevVal = prevTensionByPair.get(key) ?? 0;
          const nextRaw = Math.max(0, Math.min(70, Number(t?.level) || 0));
          return Math.round(prevVal * 0.6 + nextRaw * 0.4);
        })(),
        reason: String(t?.reason || "").slice(0, 120)
      }))
      .filter((t) => t.a && t.b)
      .slice(0, 8),
    updatedAt: Date.now()
  };
  return state.factions;
}

function activeFactions(state) {
  if (!state.factions || typeof state.factions !== "object") {
    state.factions = fallbackFactionState(state.npcs || []);
  }
  return state.factions;
}

export function setWorldEvents(state, worldEvents) {
  if (!state) return null;
  const src = worldEvents && typeof worldEvents === "object" ? worldEvents : {};
  const events = Array.isArray(src.active) ? src.active : [];
  state.worldEvents = {
    active: events
      .map((evt) => ({
        id: String(evt?.id || `evt_${Date.now()}_${Math.floor(Math.random() * 1000)}`),
        title: String(evt?.title || "Town Event").slice(0, 60),
        description: String(evt?.description || "Something unusual is happening in town.").slice(0, 180),
        severity: Math.max(1, Math.min(2, Number(evt?.severity) || 1)),
        area: String(evt?.area || "").slice(0, 40),
        effect: String(evt?.effect || "none").slice(0, 40)
      }))
      .slice(0, 4),
    updatedAt: Date.now()
  };
  return state.worldEvents;
}

function activeWorldEvents(state) {
  if (!state.worldEvents || typeof state.worldEvents !== "object") {
    state.worldEvents = fallbackWorldEvents();
  }
  return state.worldEvents;
}

export function setRumorState(state, rumorState) {
  if (!state) return null;
  const base = createRumorState();
  const src = rumorState && typeof rumorState === "object" ? rumorState : {};
  for (const area of AREAS) {
    const n = Number(src?.byArea?.[area.name]);
    base.byArea[area.name] = Number.isFinite(n) ? clamp(Math.round(n), 0, 70) : 0;
  }
  for (const role of NPC_ROLES) {
    const n = Number(src?.byRole?.[role]);
    base.byRole[role] = Number.isFinite(n) ? clamp(Math.round(n), 0, 70) : 0;
  }
  const rawTopics = Array.isArray(src?.latestTopics) ? src.latestTopics : [];
  base.latestTopics = rawTopics.map((t) => String(t || "").slice(0, 100)).filter(Boolean).slice(-8);
  base.intensity = Math.max(
    ...Object.values(base.byArea).map((n) => Number(n) || 0),
    ...Object.values(base.byRole).map((n) => Number(n) || 0),
    0
  );
  base.updatedAt = Date.now();
  state.rumorState = base;
  return state.rumorState;
}

function activeRumorState(state) {
  if (!state.rumorState || typeof state.rumorState !== "object") {
    state.rumorState = createRumorState();
  }
  return state.rumorState;
}

export function rumorHotspots(state) {
  const rs = activeRumorState(state);
  const topArea = Object.entries(rs.byArea).sort((a, b) => (b[1] || 0) - (a[1] || 0))[0] || ["", 0];
  const topRole = Object.entries(rs.byRole).sort((a, b) => (b[1] || 0) - (a[1] || 0))[0] || ["", 0];
  return {
    area: topArea[0] || "",
    areaHeat: Number(topArea[1]) || 0,
    role: topRole[0] || "",
    roleHeat: Number(topRole[1]) || 0,
    intensity: Number(rs.intensity) || 0,
    topics: rs.latestTopics || []
  };
}

function decayRumorState(rumorState, amount = 1) {
  for (const key of Object.keys(rumorState.byArea || {})) {
    rumorState.byArea[key] = Math.max(0, (Number(rumorState.byArea[key]) || 0) - amount);
  }
  for (const key of Object.keys(rumorState.byRole || {})) {
    rumorState.byRole[key] = Math.max(0, (Number(rumorState.byRole[key]) || 0) - amount);
  }
}

export function applyRumorEvent(state, textRaw) {
  const rumorState = activeRumorState(state);
  const text = String(textRaw || "").trim();
  if (!text) return rumorState;
  decayRumorState(rumorState, 1);
  const normalized = text.toLowerCase();
  for (const area of AREAS) {
    if (normalized.includes(String(area.name).toLowerCase())) {
      rumorState.byArea[area.name] = clamp((Number(rumorState.byArea[area.name]) || 0) + 3, 0, 70);
    }
  }
  for (const role of NPC_ROLES) {
    if (normalized.includes(String(role).toLowerCase())) {
      rumorState.byRole[role] = clamp((Number(rumorState.byRole[role]) || 0) + 2, 0, 70);
    }
  }
  const trimmedTopic = text.replace(/\s+/g, " ").slice(0, 100);
  rumorState.latestTopics.push(trimmedTopic);
  if (rumorState.latestTopics.length > 8) {
    rumorState.latestTopics = rumorState.latestTopics.slice(-8);
  }
  rumorState.intensity = Math.max(
    ...Object.values(rumorState.byArea).map((n) => Number(n) || 0),
    ...Object.values(rumorState.byRole).map((n) => Number(n) || 0),
    0
  );
  rumorState.updatedAt = Date.now();
  return rumorState;
}

export function setEconomyState(state, economy) {
  if (!state) return null;
  const src = economy && typeof economy === "object" ? economy : {};
  const fallback = fallbackEconomyState(state);
  const cropPrices = {};
  const demand = {};
  for (const cropType of CROP_TYPES) {
    const rawPrice = Number(src?.cropPrices?.[cropType]);
    cropPrices[cropType] = Number.isFinite(rawPrice) ? Math.max(1, Math.round(rawPrice)) : fallback.cropPrices[cropType];
    const rawDemand = String(src?.demand?.[cropType] || "").trim().toLowerCase();
    demand[cropType] = rawDemand === "high" || rawDemand === "low" ? rawDemand : fallback.demand[cropType];
  }
  state.economy = {
    mood: String(src.mood || fallback.mood).slice(0, 32),
    cropPrices,
    demand,
    missionRewardMultiplier: Math.max(0.75, Math.min(1.35, Number(src.missionRewardMultiplier) || fallback.missionRewardMultiplier)),
    note: String(src.note || fallback.note).slice(0, 160),
    updatedAt: Date.now()
  };
  return state.economy;
}

function activeEconomy(state) {
  if (!state.economy || typeof state.economy !== "object") {
    state.economy = fallbackEconomyState(state);
  }
  return state.economy;
}

function sellPriceForCrop(state, cropType) {
  const economy = activeEconomy(state);
  const dynamicPrice = Number(economy?.cropPrices?.[cropType]);
  if (Number.isFinite(dynamicPrice) && dynamicPrice > 0) return Math.round(dynamicPrice);
  return Number(CROP_CONFIG[cropType]?.sellPrice) || 1;
}

export function missionRewardCoins(state, mission) {
  const economy = activeEconomy(state);
  const objective = String(mission?.objectiveType || "");
  let base = 4;
  if (objective === "harvest_count") base = 6;
  if (objective === "talk_unique_npcs" || objective === "visit_unique_areas") base = 5;
  if (objective === "talk_npc" || objective === "talk_role") base = 5;
  const targetCount = Math.max(1, Number(mission?.targetCount) || 1);
  const scaled = base + Math.max(0, targetCount - 1);
  return Math.max(1, Math.round(scaled * (Number(economy.missionRewardMultiplier) || 1)));
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

export function setStoryArc(state, arc) {
  if (!state) return null;
  const safe = arc && typeof arc === "object" ? arc : {};
  const stages = Array.isArray(safe.stages)
    ? safe.stages.map((s) => String(s || "").trim()).filter(Boolean).slice(0, 3)
    : [];
  while (stages.length < 3) {
    stages.push(fallbackStoryArc(state).stages[stages.length]);
  }
  state.storyArc = {
    id: String(safe.id || `arc_${state.dayNumber}_${Date.now()}`),
    title: String(safe.title || "Town Undercurrents").slice(0, 60),
    summary: String(safe.summary || "People in town are reacting to recent events.").slice(0, 180),
    stages,
    stageIndex: Math.max(0, Math.min(stages.length - 1, Number(safe.stageIndex) || 0)),
    stageProgress: Math.max(0, Number(safe.stageProgress) || 0),
    stageTarget: Math.max(1, Math.min(4, Number(safe.stageTarget) || 2)),
    completed: Boolean(safe.completed),
    branchOutcome: String(safe.branchOutcome || "").slice(0, 140),
    updatedAt: Date.now()
  };
  return state.storyArc;
}

function activeStoryArc(state) {
  if (!state.storyArc || typeof state.storyArc !== "object") {
    state.storyArc = fallbackStoryArc(state);
  }
  return state.storyArc;
}

export function progressStoryArc(state, signal = "") {
  const arc = activeStoryArc(state);
  if (arc.completed) return { changed: false, arc };

  arc.stageProgress += 1;
  const changed = true;
  if (arc.stageProgress < arc.stageTarget) {
    arc.updatedAt = Date.now();
    return { changed, stageAdvanced: false, completed: false, arc };
  }

  arc.stageProgress = 0;
  arc.stageIndex += 1;
  if (arc.stageIndex >= arc.stages.length) {
    arc.stageIndex = arc.stages.length - 1;
    arc.completed = true;
    const s = String(signal || "").toLowerCase();
    arc.branchOutcome = s.includes("harvest") || s.includes("talk")
      ? "Town accepted calmer explanations and trust improved."
      : "People remained wary, and guard patrols stayed strict.";
  }
  arc.updatedAt = Date.now();
  return { changed, stageAdvanced: true, completed: arc.completed, arc };
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
  if (progress.index >= MISSION_CHAIN.length) {
    return progress.dynamicMission || null;
  }
  return MISSION_CHAIN[progress.index];
}

function normalizeDynamicMission(mission) {
  if (!mission || typeof mission !== "object") return null;
  const objectiveType = String(mission.objectiveType || "")
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
  if (!allowed.has(objectiveType)) return null;

  const safe = {
    id: String(mission.id || `dynamic_${Date.now()}`),
    title: String(mission.title || "Dynamic Mission").slice(0, 60),
    description: String(mission.description || "Follow current town developments.").slice(0, 180),
    objectiveType
  };
  if (mission.targetNpcId) safe.targetNpcId = String(mission.targetNpcId);
  if (mission.targetRole) safe.targetRole = String(mission.targetRole);
  if (mission.targetArea) safe.targetArea = String(mission.targetArea);
  if (Number.isFinite(Number(mission.targetCount))) {
    safe.targetCount = Math.max(1, Math.min(6, Number(mission.targetCount)));
  }
  safe.urgency = Math.max(1, Math.min(3, Number(mission.urgency) || 1));
  safe.whyNow = String(mission.whyNow || "").slice(0, 140);
  if (Number.isFinite(Number(mission.rewardCoins))) {
    safe.rewardCoins = Math.max(1, Math.round(Number(mission.rewardCoins)));
  }
  return safe;
}

export function setPlayerDynamicMission(player, mission) {
  const progress = ensurePlayerMissionProgress(player);
  progress.dynamicMission = normalizeDynamicMission(mission);
  progress.harvestCount = 0;
  progress.spokenNpcIds = [];
  progress.spokenRoles = [];
  progress.visitedAreas = [];
  return progress.dynamicMission;
}

function missionProgressText(player) {
  const progress = ensurePlayerMissionProgress(player);
  const mission = currentMission(player);
  if (!mission) return "All missions complete.";

  if (mission.objectiveType === "reach_point") {
    return "Go to the marked location.";
  }
  if (mission.objectiveType === "talk_npc") {
    return "Find and speak to the target person.";
  }
  if (mission.objectiveType === "talk_role") {
    return `Speak to someone with role ${mission.targetRole || "target role"}.`;
  }
  if (mission.objectiveType === "visit_area") {
    return `Travel to ${mission.targetArea || "the target area"}.`;
  }
  if (mission.objectiveType === "harvest_count") {
    const target = mission.targetCount || 1;
    const done = Math.min(target, progress.harvestCount);
    return `Harvest progress: ${done}/${target}.`;
  }
  if (mission.objectiveType === "talk_unique_npcs") {
    const target = mission.targetCount || 1;
    const done = Math.min(target, progress.spokenNpcIds.length);
    return `People met: ${done}/${target}.`;
  }
  if (mission.objectiveType === "talk_unique_roles") {
    const target = mission.targetCount || 1;
    const done = Math.min(target, progress.spokenRoles.length);
    return `Roles met: ${done}/${target}.`;
  }
  if (mission.objectiveType === "visit_unique_areas") {
    const target = mission.targetCount || 1;
    const done = Math.min(target, progress.visitedAreas.length);
    return `Areas visited: ${done}/${target}.`;
  }
  return "Keep exploring town.";
}

function advanceMission(player) {
  const progress = ensurePlayerMissionProgress(player);
  const mission = currentMission(player);
  if (!mission) return null;

  const inBaseChain = progress.index < MISSION_CHAIN.length;
  if (inBaseChain) {
    progress.index += 1;
  } else {
    progress.dynamicCompleted += 1;
    progress.dynamicMission = null;
  }
  if (mission.objectiveType === "harvest_count") {
    progress.harvestCount = 0;
  }
  if (mission.objectiveType === "talk_unique_npcs") {
    progress.spokenNpcIds = [];
  }
  if (mission.objectiveType === "talk_unique_roles") {
    progress.spokenRoles = [];
  }
  if (mission.objectiveType === "visit_unique_areas") {
    progress.visitedAreas = [];
  }
  const next = currentMission(player);
  return { completed: mission, next };
}

export function applyMissionEvent(player, event) {
  if (!player) return { changed: false };
  const progress = ensurePlayerMissionProgress(player);
  const mission = currentMission(player);
  if (!mission) return { changed: false };

  if (mission.objectiveType === "reach_point" && event?.type === "move") {
    const x = Number(event?.x);
    const y = Number(event?.y);
    const tx = Number(mission.targetX);
    const ty = Number(mission.targetY);
    const radius = Number(mission.targetRadius) || 80;
    if (Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(tx) && Number.isFinite(ty) && Math.hypot(x - tx, y - ty) <= radius) {
      const result = advanceMission(player);
      return {
        changed: true,
        completedMission: result?.completed || null,
        nextMission: result?.next || null
      };
    }
  }

  if (mission.objectiveType === "talk_npc" && event?.type === "talk_npc" && event?.npcId === mission.targetNpcId) {
    const result = advanceMission(player);
    return {
      changed: true,
      completedMission: result?.completed || null,
      nextMission: result?.next || null
    };
  }

  if (mission.objectiveType === "talk_role" && event?.type === "talk_npc_role") {
    const role = String(event?.role || "").trim();
    if (role && role === mission.targetRole) {
      const result = advanceMission(player);
      return {
        changed: true,
        completedMission: result?.completed || null,
        nextMission: result?.next || null
      };
    }
  }

  if (mission.objectiveType === "visit_area" && event?.type === "move") {
    const areaName = String(event?.areaName || "").trim();
    if (areaName && areaName === mission.targetArea) {
      const result = advanceMission(player);
      return {
        changed: true,
        completedMission: result?.completed || null,
        nextMission: result?.next || null
      };
    }
    return { changed: false };
  }

  if (mission.objectiveType === "harvest_count" && event?.type === "harvest_success") {
    progress.harvestCount += 1;
    const done = progress.harvestCount >= (mission.targetCount || 1);
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

  if (mission.objectiveType === "talk_unique_npcs" && event?.type === "talk_npc") {
    const npcId = String(event?.npcId || "").trim();
    if (!npcId) return { changed: false };
    if (!progress.spokenNpcIds.includes(npcId)) {
      progress.spokenNpcIds.push(npcId);
      const done = progress.spokenNpcIds.length >= (mission.targetCount || 1);
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

  if (mission.objectiveType === "talk_unique_roles" && event?.type === "talk_npc_role") {
    const role = String(event?.role || "").trim();
    if (!role) return { changed: false };
    if (!progress.spokenRoles.includes(role)) {
      progress.spokenRoles.push(role);
      const done = progress.spokenRoles.length >= (mission.targetCount || 1);
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

  if (mission.objectiveType === "visit_unique_areas" && event?.type === "move") {
    const areaName = String(event?.areaName || "").trim();
    if (!areaName) return { changed: false };
    if (!progress.visitedAreas.includes(areaName)) {
      progress.visitedAreas.push(areaName);
      const done = progress.visitedAreas.length >= (mission.targetCount || 1);
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
    const totalComplete = MISSION_CHAIN.length + progress.dynamicCompleted;
    return {
      completed: true,
      title: "All Missions Complete",
      description: "No active missions right now.",
      progress: "Great work. More missions soon.",
      step: totalComplete,
      total: totalComplete
    };
  }
  const inBaseChain = progress.index < MISSION_CHAIN.length;
  const dynamicOrdinal = progress.dynamicCompleted + 1;
  const computedStep = inBaseChain ? progress.index + 1 : MISSION_CHAIN.length + dynamicOrdinal;
  const computedTotal = inBaseChain ? MISSION_CHAIN.length : computedStep;
  return {
    id: mission.id,
    completed: false,
    title: mission.title,
    description: mission.description,
    urgency: mission.urgency || 1,
    whyNow: mission.whyNow || "",
    rewardCoins: Number(mission.rewardCoins) || null,
    progress: missionProgressText(player),
    step: computedStep,
    total: computedTotal
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
    const sellPrice = sellPriceForCrop(state, plot.cropType);
    const totalCoins = yieldCount * sellPrice;
    farm.inventory[plot.cropType] = (farm.inventory[plot.cropType] || 0) + yieldCount;
    farm.coins += totalCoins;

    const harvestedCropLabel = crop.label;
    plot.state = "empty";
    plot.cropType = null;
    plot.growth = 0;
    plot.water = 0;
    plot.wateredAt = null;

    return {
      ok: true,
      message: `Harvested ${yieldCount} ${harvestedCropLabel}${yieldCount > 1 ? "s" : ""} (+${totalCoins} coins @ ${sellPrice}/each).`,
      economy: {
        cropType: plot.cropType,
        sellPrice,
        totalCoins
      }
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
    characterProfile: buildNpcCharacterProfile(seed),
    routineState: {
      phase: "rest",
      venueType: "home",
      areaName: seed.area,
      isHoliday: false
    },
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
    rumorState: createRumorState(),
    worldEvents: fallbackWorldEvents(),
    factions: fallbackFactionState(npcs),
    dailyTownLog: [],
    yesterdayTownLog: [],
    storyArc: fallbackStoryArc({ dayNumber: 1 }),
    economy: fallbackEconomyState({ dayNumber: 1 }),
    townMission: fallbackTownMission({ dayNumber: 1, rumorOfTheDay: "A hidden lantern was seen near the forest shrine." }),
    routineNudges: {},
    npcs,
    npcRelations: {},
    players: new Map(),
    farms: new Map()
  };
}

export function setRoutineNudges(state, nudges) {
  if (!state) return {};
  const out = {};
  const list = Array.isArray(nudges) ? nudges : [];
  for (const item of list) {
    const role = String(item?.role || "").trim();
    if (!role) continue;
    out[role] = {
      shiftMinutes: Math.max(-120, Math.min(120, Number(item?.shiftMinutes) || 0)),
      afterWorkArea: item?.afterWorkArea ? String(item.afterWorkArea).slice(0, 40) : "",
      reason: String(item?.reason || "").slice(0, 120)
    };
  }
  state.routineNudges = out;
  return out;
}

export function hydrateNpcRelations(state, rawRelations) {
  if (!state) return {};
  const src = rawRelations && typeof rawRelations === "object" ? rawRelations : {};
  const out = {};
  for (const [key, value] of Object.entries(src)) {
    const pair = unpackRelationKey(key);
    if (!pair) continue;
    const score = Number(value?.score);
    out[key] = {
      score: Number.isFinite(score) ? clamp(Math.round(score), -10, 10) : 0,
      reason: String(value?.reason || "").slice(0, 140),
      updatedAt: Number.isFinite(Number(value?.updatedAt)) ? Number(value.updatedAt) : Date.now()
    };
  }
  state.npcRelations = out;
  return out;
}

export function getNpcRelationScore(state, aId, bId) {
  if (!state) return 0;
  const key = relationPairKey(aId, bId);
  if (!key) return 0;
  const rel = state.npcRelations?.[key];
  return Number.isFinite(Number(rel?.score)) ? Number(rel.score) : 0;
}

export function getNpcRelationLabel(score) {
  const s = Number(score) || 0;
  if (s >= 6) return "allies";
  if (s >= 2) return "friendly";
  if (s <= -6) return "grudge";
  if (s <= -2) return "cold";
  return "neutral";
}

export function bumpNpcRelation(state, aId, bId, delta = 0, reason = "") {
  if (!state) return null;
  const key = relationPairKey(aId, bId);
  if (!key) return null;
  const prev = Number(state.npcRelations?.[key]?.score) || 0;
  const nextScore = clamp(Math.round(prev + (Number(delta) || 0)), -10, 10);
  if (!state.npcRelations || typeof state.npcRelations !== "object") {
    state.npcRelations = {};
  }
  state.npcRelations[key] = {
    score: nextScore,
    reason: String(reason || "").slice(0, 140),
    updatedAt: Date.now()
  };
  return {
    key,
    score: nextScore,
    label: getNpcRelationLabel(nextScore)
  };
}

export function relationHintsForNpc(state, npcId, limit = 3) {
  const id = normalizeEntityId(npcId);
  if (!id || !state?.npcRelations) return [];
  const hints = [];
  for (const [key, value] of Object.entries(state.npcRelations)) {
    const pair = unpackRelationKey(key);
    if (!pair) continue;
    const otherId = pair.a === id ? pair.b : pair.b === id ? pair.a : "";
    if (!otherId) continue;
    const score = Number(value?.score) || 0;
    if (score === 0) continue;
    hints.push({
      otherId,
      score,
      label: getNpcRelationLabel(score),
      reason: String(value?.reason || "")
    });
  }
  hints.sort((a, b) => Math.abs(b.score) - Math.abs(a.score));
  return hints.slice(0, Math.max(1, limit));
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

function snapshotDerivedKey(state) {
  const arcUpdated = Number(state?.storyArc?.updatedAt) || 0;
  const ecoUpdated = Number(state?.economy?.updatedAt) || 0;
  const evtUpdated = Number(state?.worldEvents?.updatedAt) || 0;
  const facUpdated = Number(state?.factions?.updatedAt) || 0;
  const rumorUpdated = Number(state?.rumorState?.updatedAt) || 0;
  return [
    Number(state?.dayNumber) || 0,
    Number(state?.timeMinutes) || 0,
    String(state?.weather || ""),
    String(state?.rumorOfTheDay || ""),
    arcUpdated,
    ecoUpdated,
    evtUpdated,
    facUpdated,
    rumorUpdated
  ].join("|");
}

function snapshotDerivedShared(state) {
  if (!state || typeof state !== "object") {
    return {
      factions: null,
      worldEvents: null,
      rumorState: { intensity: 0, area: "", role: "", areaHeat: 0, roleHeat: 0, topics: [] },
      storyArc: {
        id: "",
        title: "",
        summary: "",
        currentStage: "",
        stageIndex: 1,
        stageTotal: 1,
        progress: "0/0",
        completed: false,
        branchOutcome: ""
      },
      economy: {
        mood: "steady",
        cropPrices: {},
        demand: {},
        missionRewardMultiplier: 1,
        note: ""
      }
    };
  }
  const key = snapshotDerivedKey(state);
  const existing = state._snapshotCache;
  if (existing?.key === key && existing?.derived) {
    return existing.derived;
  }

  const hs = rumorHotspots(state);
  const arc = activeStoryArc(state);
  const economy = activeEconomy(state);
  const derived = {
    factions: activeFactions(state),
    worldEvents: activeWorldEvents(state),
    rumorState: {
      intensity: hs.intensity,
      area: hs.area,
      role: hs.role,
      areaHeat: hs.areaHeat,
      roleHeat: hs.roleHeat,
      topics: hs.topics
    },
    storyArc: {
      id: arc.id,
      title: arc.title,
      summary: arc.summary,
      currentStage: arc.stages[Math.max(0, Math.min(arc.stageIndex, arc.stages.length - 1))] || "",
      stageIndex: arc.stageIndex + 1,
      stageTotal: arc.stages.length,
      progress: `${Math.min(arc.stageProgress, arc.stageTarget)}/${arc.stageTarget}`,
      completed: arc.completed,
      branchOutcome: arc.branchOutcome || ""
    },
    economy: {
      mood: economy.mood,
      cropPrices: economy.cropPrices,
      demand: economy.demand,
      missionRewardMultiplier: economy.missionRewardMultiplier,
      note: economy.note
    }
  };
  state._snapshotCache = { key, derived };
  return derived;
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
    if (controlMode) {
      npc.routineState = {
        phase: "player_command",
        venueType: controlMode,
        areaName: npc.area,
        isHoliday: false,
        weekDay: WEEK_DAYS[weekdayForDay(state.dayNumber)] || "Moonday"
      };
    }
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

    const hasActiveTask = Array.isArray(npc.tasks)
      ? npc.tasks.some((t) => t?.status === "in_progress")
      : false;
    if (!controlMode && !hasActiveTask) {
      const routine = resolveNpcRoutine(state, npc);
      if (routine) {
        npc.routineState = {
          phase: routine.phase,
          venueType: routine.venueType,
          areaName: routine.areaName,
          isHoliday: Boolean(routine.isHoliday),
          weekDay: WEEK_DAYS[weekdayForDay(state.dayNumber)] || "Moonday"
        };
        const area = AREAS.find((a) => a.name === routine.areaName);
        if (area) {
          if (routine.style === "patrol") {
            const reachedCurrent = npc.target
              ? Math.hypot((npc.target.x || npc.x) - npc.x, (npc.target.y || npc.y) - npc.y) < 18
              : true;
            if (!npc.target || reachedCurrent || Math.random() < 0.03) {
              npc.target = pickWanderTarget(area);
            }
          } else if (!npc.target || Math.random() < 0.02 || npc.area !== area.name) {
            npc.target = pickWanderTarget(area);
          }
        }
      }
    }

    if (!controlMode && now < npc.holdUntil) {
      npc.vx = 0;
      npc.vy = 0;
      continue;
    }

    const hostile = state.npcs.find((other) => {
      if (!other || other.id === npc.id) return false;
      const score = getNpcRelationScore(state, npc.id, other.id);
      if (score > -5) return false;
      return Math.hypot(other.x - npc.x, other.y - npc.y) <= 120;
    });
    if (!controlMode && hostile && Math.random() < 0.35) {
      const dx = npc.x - hostile.x;
      const dy = npc.y - hostile.y;
      const d = Math.max(1, Math.hypot(dx, dy));
      const ux = dx / d;
      const uy = dy / d;
      npc.target = {
        x: clamp(npc.x + ux * 95 + (Math.random() * 20 - 10), 0, WORLD_WIDTH),
        y: clamp(npc.y + uy * 95 + (Math.random() * 20 - 10), 0, WORLD_HEIGHT)
      };
    } else if (!npc.target || Math.random() < 0.02) {
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
  const shared = snapshotDerivedShared(state);

  return {
    dayNumber: state.dayNumber,
    timeMinutes: state.timeMinutes,
    timeLabel: timeLabel(state.timeMinutes),
    weather: state.weather,
    rumorOfTheDay: state.rumorOfTheDay,
    factions: shared.factions,
    worldEvents: shared.worldEvents,
    rumorState: shared.rumorState,
    storyArc: shared.storyArc,
    economy: shared.economy,
    npcs: state.npcs.map((n) => ({
      id: n.id,
      name: n.name,
      role: n.role,
      traits: n.traits,
      x: n.x,
      y: n.y,
      area: n.area,
      routineState: n.routineState || null,
      characterProfile: n.characterProfile || null,
      relationHints: relationHintsForNpc(state, n.id, 2)
    })),
    you: player
      ? {
          id: player.id,
          playerId: player.playerId,
          name: player.name,
          gender: player.gender,
          x: player.x,
          y: player.y,
          reputation: (() => {
            const rep = ensurePlayerReputation(player);
            return {
              global: rep.global,
              label: reputationLabel(rep.global),
              byRole: rep.byRole
            };
          })()
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
  applyRumorEvent(state, text);
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
