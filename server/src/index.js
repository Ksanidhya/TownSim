import "dotenv/config";
import express from "express";
import cors from "cors";
import http from "node:http";
import crypto from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { Server } from "socket.io";
import {
  createPlayerAccount,
  ensureSchema,
  getPlayerByUsername,
  initDb,
  getRecentMemoriesByTag,
  getRecentMemories,
  hasNpcIntroducedToPlayer,
  touchPlayerLogin,
  upsertRelationshipDelta,
  writeMemory
} from "./db.js";
import { DialogueService } from "./dialogue.js";
import { AREAS } from "./constants.js";
import {
  buildFollowupMemoryContext,
  compactMemoryLines,
  composeContinuityHint,
  getOrCreateDailyFollowupHint
} from "./followup.js";
import { createCooldownGate } from "./ai-control.js";
import { runDailyRefreshPipeline } from "./daily-reset.js";
import {
  MISSION_CHAIN,
  applyPlayerReputationDelta,
  applyTownMissionEvent,
  applyMissionEvent,
  applyFarmAction,
  missionRewardCoins,
  areaNameAt,
  bumpNpcRelation,
  createPlayerFarmIfMissing,
  createWorldState,
  ensurePlayerMissionProgress,
  ensurePlayerReputation,
  findNearbyNpcPairs,
  getNpcRelationLabel,
  getNpcRelationScore,
  hydrateNpcRelations,
  progressStoryArc,
  pushTownEvent,
  rumorHotspots,
  relationHintsForNpc,
  removePlayerFarm,
  setPlayerDynamicMission,
  setEconomyState,
  setFactionState,
  setWorldEvents,
  setRumorState,
  setRoutineNudges,
  setStoryArc,
  setTownMission,
  snapshotWorld,
  tickClock,
  tickFarmGrowth,
  tickNpcMovement
} from "./world.js";

const PORT = Number(process.env.PORT || 3002);
const DEFAULT_CLIENT_ORIGINS = ["http://localhost:5173", "http://127.0.0.1:5173"];
const CLIENT_ORIGINS = String(process.env.CLIENT_ORIGIN || "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
const CLIENT_ORIGIN_SET = new Set([...DEFAULT_CLIENT_ORIGINS, ...CLIENT_ORIGINS]);
const isAllowedOrigin = (origin) => !origin || CLIENT_ORIGIN_SET.has(origin);

const corsOptions = {
  origin(origin, callback) {
    if (isAllowedOrigin(origin)) {
      callback(null, true);
      return;
    }
    callback(new Error(`Not allowed by CORS: ${origin}`));
  }
};
const AUTOSAVE_INTERVAL_MS = Number(process.env.AUTOSAVE_INTERVAL_MS || 15000);
const SAVE_DIR = path.resolve(process.cwd(), "data");
const SAVE_PATH = path.join(SAVE_DIR, "world-save.json");

const app = express();
app.use(cors(corsOptions));
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin(origin, callback) {
      if (isAllowedOrigin(origin)) {
        callback(null, true);
        return;
      }
      callback(new Error(`Not allowed by Socket.IO CORS: ${origin}`));
    },
    methods: ["GET", "POST"]
  }
});

const db = initDb();
const dialogueService = new DialogueService(process.env.OPENAI_API_KEY);
const world = createWorldState();
const PLAYER_NEAR_DISTANCE = 75;
const AUTO_DIALOGUE_MIN_INTERVAL_MS = 18000;
const NPC_COOLDOWN_MS = 30000;
const SLEEP_SYNC_INTERVAL_TICKS = 5;
const FARM_ACTION_DISTANCE = 90;
const DIALOGUE_CHUNK_WORDS = 12;
const DIALOGUE_CHUNK_THRESHOLD_WORDS = 16;
const NPC_NPC_MIN_TURNS = 2;
const NPC_NPC_MAX_TURNS = 3;
const NPC_NPC_TURN_DELAY_MS = 5000;
const OVERNIGHT_SKIP_START_MINUTES = 2 * 60;
const OVERNIGHT_SKIP_END_MINUTES = 6 * 60;
const RELATIONSHIP_AI_COOLDOWN_MS = 18_000;
let lastAutoDialogueAt = 0;
let tickCount = 0;
let npcConversationInProgress = false;
let npcConversationCancelRequested = false;
let npcTaskInProgress = false;
let autosaveInProgress = false;
const persistedProfiles = new Map();
const dailyFollowupHintCache = new Map();
const relationshipAiGate = createCooldownGate({ maxKeys: 3000 });
const TOWN_LIFE_TOPIC_HINTS = [
  "daily life in town",
  "work and personal mood today",
  "neighbors and people around town",
  "food, chores, and routines",
  "weather and how it affects plans",
  "small worries and hopes"
];

function cleanForMatch(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .replace(/\s+/g, " ");
}

function findNpcByNameLike(nameRaw) {
  const needle = cleanForMatch(nameRaw);
  if (!needle) return null;
  return (
    world.npcs.find((npc) => cleanForMatch(npc.name) === needle) ||
    world.npcs.find((npc) => cleanForMatch(npc.name).includes(needle) || needle.includes(cleanForMatch(npc.name))) ||
    null
  );
}

function findAreaByNameLike(nameRaw) {
  const needle = cleanForMatch(nameRaw);
  if (!needle) return null;
  return (
    AREAS.find((area) => cleanForMatch(area.name) === needle) ||
    AREAS.find((area) => cleanForMatch(area.name).includes(needle) || needle.includes(cleanForMatch(area.name))) ||
    null
  );
}

function parseTimeExpression(raw) {
  const text = String(raw || "").trim().toLowerCase();
  if (!text) return null;
  const map = {
    dawn: 6 * 60,
    morning: 8 * 60,
    noon: 12 * 60,
    afternoon: 15 * 60,
    dusk: 16 * 60,
    evening: 18 * 60,
    night: 20 * 60,
    midnight: 0
  };
  if (Object.prototype.hasOwnProperty.call(map, text)) return map[text];

  const match = text.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i);
  if (!match) return null;
  let hour = Number(match[1]);
  const minute = Number(match[2] || 0);
  const suffix = String(match[3] || "").toLowerCase();
  if (minute < 0 || minute > 59 || hour < 0 || hour > 23) return null;
  if (suffix) {
    if (hour < 1 || hour > 12) return null;
    if (suffix === "am") {
      hour = hour === 12 ? 0 : hour;
    } else {
      hour = hour === 12 ? 12 : hour + 12;
    }
  }
  return hour * 60 + minute;
}

function formatMinutesClock(minutes) {
  if (!Number.isFinite(minutes)) return "";
  const total = ((minutes % (24 * 60)) + 24 * 60) % (24 * 60);
  const h24 = Math.floor(total / 60);
  const mins = total % 60;
  const suffix = h24 >= 12 ? "PM" : "AM";
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${h12}:${String(mins).padStart(2, "0")} ${suffix}`;
}

function parseDurationMinutes(raw) {
  const text = String(raw || "").trim().toLowerCase();
  if (!text) return null;
  const match = text.match(/^(\d+)\s*(hours?|hrs?|hr|minutes?|mins?|min)$/i);
  if (!match) return null;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  const unit = String(match[2] || "").toLowerCase();
  if (unit.startsWith("hour") || unit === "hr" || unit === "hrs") {
    return amount * 60;
  }
  return amount;
}

function formatDurationLabel(durationMinutes) {
  const mins = Math.max(1, Math.round(Number(durationMinutes) || 0));
  if (mins % 60 === 0) {
    const hours = mins / 60;
    return `${hours} hour${hours === 1 ? "" : "s"}`;
  }
  return `${mins} minute${mins === 1 ? "" : "s"}`;
}

function clockMomentToAbsolute(dayNumber, timeMinutes) {
  const safeDay = Math.max(1, Number(dayNumber) || 1);
  const safeMinute = ((Number(timeMinutes) || 0) % (24 * 60) + 24 * 60) % (24 * 60);
  return (safeDay - 1) * 24 * 60 + safeMinute;
}

function absoluteToClockMoment(absoluteMinutes) {
  const total = Math.max(0, Math.floor(Number(absoluteMinutes) || 0));
  const dayNumber = Math.floor(total / (24 * 60)) + 1;
  const timeMinutes = total % (24 * 60);
  return { dayNumber, timeMinutes };
}

function addClockDuration(dayNumber, timeMinutes, deltaMinutes) {
  const abs = clockMomentToAbsolute(dayNumber, timeMinutes);
  return absoluteToClockMoment(abs + Math.max(0, Math.floor(Number(deltaMinutes) || 0)));
}

function looksLikeObservationQuestion(text) {
  const normalized = cleanForMatch(text);
  if (!normalized) return false;
  if (
    /\b(what did you see|what did you notice|what happened there|who was there|how did .* look|how was .* looking|give me your report)\b/i.test(
      normalized
    )
  ) {
    return true;
  }
  return /\b(saw|see|noticed|observe|observed|report|there)\b/i.test(normalized) && /\?/.test(String(text || ""));
}

function areaVisualSummary(areaName, minutes, weather) {
  const hour = Math.floor((((minutes % (24 * 60)) + 24 * 60) % (24 * 60)) / 60);
  const timeMood =
    hour < 6 ? "quiet and dim" : hour < 12 ? "fresh and active" : hour < 17 ? "busy and sunlit" : hour < 21 ? "warm and lantern-lit" : "shadowy and hushed";
  const weatherMood =
    String(weather || "").toLowerCase() === "rain"
      ? "Stones were slick with rain."
      : String(weather || "").toLowerCase() === "storm"
        ? "The wind made everything feel tense."
        : "Air felt steady and clear.";
  const byArea = {
    "Town Square": `The square looked ${timeMood}, with banners and cobbles catching the light.`,
    "Market Street": `Stalls and awnings looked ${timeMood}, colors shifting with passing shadows.`,
    Dock: `The docks looked ${timeMood}, timber dark against the water.`,
    Sanctum: `The sanctum looked ${timeMood}, pale stone holding a calm glow.`,
    Forest: `The forest edge looked ${timeMood}, leaves moving in soft layers.`,
    Housing: `The homes looked ${timeMood}, warm windows and tidy lanes.`
  };
  return `${byArea[areaName] || `That place looked ${timeMood}.`} ${weatherMood}`;
}

function crowdLabel(count) {
  if (count <= 0) return "empty";
  if (count <= 2) return "light";
  if (count <= 4) return "steady";
  return "busy";
}

function parseObservationMemory(memory) {
  if (!memory || memory.memory_type !== "observation_report") return null;
  const raw = String(memory.content || "").trim();
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    return parsed;
  } catch {
    return null;
  }
}

function areaMentionFromText(text) {
  const normalized = cleanForMatch(text);
  if (!normalized) return null;
  for (const area of AREAS) {
    const areaName = cleanForMatch(area.name);
    if (normalized.includes(areaName)) return area.name;
  }
  return null;
}

function buildObservationReplyLine(npc, report) {
  const people = Array.isArray(report.peopleSeen) ? report.peopleSeen.slice(0, 4) : [];
  const peopleText =
    people.length > 0
      ? `I spotted ${people.join(", ")} there.`
      : "I didn't spot anyone I could name there.";
  const detail = String(report.buildingLook || "").trim() || "Buildings looked ordinary, nothing damaged.";
  const crowdText = `The place felt ${report.crowdLevel || "quiet"}.`;
  const whenText =
    report.endTimeLabel && report.endDayNumber
      ? `At ${report.endTimeLabel} on day ${report.endDayNumber}`
      : "When I watched";
  const creativeByTrait = {
    observant: "I kept close track of little shifts in mood.",
    curious: "I watched longer than needed, chasing little details.",
    vigilant: "I checked corners and movement patterns carefully.",
    dramatic: "The scene had a strong mood, hard to ignore."
  };
  const traitKey = (npc?.traits || []).find((t) => Object.prototype.hasOwnProperty.call(creativeByTrait, t));
  const creative = traitKey ? creativeByTrait[traitKey] : "I remember it clearly.";
  return `${whenText}, in ${report.areaName}: ${peopleText} ${crowdText} ${detail} ${creative}`;
}

function parseNpcTaskCommand(text) {
  const raw = String(text || "").trim();
  if (!raw) return null;

  const talkPattern =
    /\b(?:talk|speak|chat)\s+to\s+([a-zA-Z\s'.-]+?)\s+about\s+(.+)$/i;
  const talkMatch = raw.match(talkPattern);
  if (talkMatch) {
    return {
      type: "talk_to_npc",
      targetNpcName: talkMatch[1].trim(),
      topic: talkMatch[2].trim()
    };
  }

  const observeMatch = raw.match(/^(?:observe|watch|check|patrol)\s*(.*)$/i);
  if (observeMatch) {
    let tail = String(observeMatch[1] || "").trim();
    let atTimeText = "";
    let durationMinutes = 60;

    const durationMatch = tail.match(/\bfor\s+(\d+\s*(?:hours?|hrs?|hr|minutes?|mins?|min))\b/i);
    if (durationMatch) {
      durationMinutes = parseDurationMinutes(durationMatch[1]) || 60;
      tail = `${tail.slice(0, durationMatch.index)} ${tail.slice((durationMatch.index || 0) + durationMatch[0].length)}`
        .replace(/\s+/g, " ")
        .trim();
    }

    const atMatch = tail.match(/\bat\s+([a-zA-Z0-9:\s]+)$/i);
    if (atMatch) {
      atTimeText = String(atMatch[1] || "").trim();
      tail = tail.slice(0, atMatch.index).trim();
    }

    const areaName = tail.replace(/^the\s+/i, "").trim();
    return {
      type: "observe_area",
      areaName: areaName || "anywhere",
      atTimeText,
      durationMinutes
    };
  }

  return null;
}

function parseNpcMovementCommand(text) {
  const raw = String(text || "").trim();
  if (!raw) return null;

  const followUntilMatch = raw.match(/^follow me until (.+)$/i);
  if (followUntilMatch) {
    return { type: "follow_player_until", untilText: followUntilMatch[1].trim() };
  }

  if (/^(follow me|come with me)$/i.test(raw)) {
    return { type: "follow_player" };
  }
  if (/^(keep distance|keep your distance|stay back)$/i.test(raw)) {
    return { type: "keep_distance" };
  }
  if (/^(return to your routine|return to routine|resume routine|go back to normal)$/i.test(raw)) {
    return { type: "return_routine" };
  }
  if (/^(go to my house|go to my home|head to my house)$/i.test(raw)) {
    return { type: "go_player_home" };
  }
  if (/^(stop|hold|stay(?: here)?)$/i.test(raw)) {
    return { type: "hold" };
  }

  const goMatch = raw.match(/^(?:go|move|head|walk)\s+to\s+(.+?)(?:\s+for\s+(\d+\s*(?:hours?|hrs?|hr|minutes?|mins?|min)))?$/i);
  if (goMatch) {
    return {
      type: "go_area",
      areaName: goMatch[1].trim(),
      durationMinutes: parseDurationMinutes(goMatch[2])
    };
  }

  const patrolMatch = raw.match(/^patrol\s+(.+?)(?:\s+for\s+(\d+\s*(?:hours?|hrs?|hr|minutes?|mins?|min)))?$/i);
  if (patrolMatch) {
    return {
      type: "patrol_area",
      areaName: patrolMatch[1].trim(),
      durationMinutes: parseDurationMinutes(patrolMatch[2])
    };
  }

  return null;
}

function getSocketIdByPlayerId(playerId) {
  for (const [socketId, player] of world.players.entries()) {
    if (player?.playerId === playerId) return socketId;
  }
  return null;
}

function notifyPlayerByPlayerId(playerId, message, ok = true) {
  const socketId = getSocketIdByPlayerId(playerId);
  if (!socketId) return;
  io.to(socketId).emit("farm_feedback", { ok, message });
  emitWorldToPlayer(socketId, "world_tick");
}

function nearestNpcToPlayer(player, maxDistance = PLAYER_NEAR_DISTANCE + 20) {
  if (!player) return null;
  let best = null;
  let bestDist = Infinity;
  for (const npc of world.npcs) {
    const dist = Math.hypot(npc.x - player.x, npc.y - player.y);
    if (dist <= maxDistance && dist < bestDist) {
      best = npc;
      bestDist = dist;
    }
  }
  return best;
}

function applyNpcMovementControl({ npc, player, parsed }) {
  if (!npc || !player || !parsed?.type) {
    return { ok: false, message: "Invalid movement command." };
  }
  if (!Array.isArray(npc.tasks)) npc.tasks = [];
  npc.tasks = [];

  if (parsed.type === "return_routine") {
    npc.moveControl = null;
    npc.target = null;
    return { ok: true, message: `${npc.name} returned to their normal routine.` };
  }

  if (parsed.type === "follow_player_until") {
    const untilMinutes = parseTimeExpression(parsed.untilText);
    if (!Number.isFinite(untilMinutes)) {
      return { ok: false, message: `Couldn't understand time "${parsed.untilText}".` };
    }
    const untilDay = untilMinutes <= world.timeMinutes ? world.dayNumber + 1 : world.dayNumber;
    npc.moveControl = {
      mode: "follow_player",
      playerId: player.playerId,
      untilMinutes,
      untilDay
    };
    npc.holdUntil = 0;
    return {
      ok: true,
      message: `${npc.name} will follow you until ${formatMinutesClock(untilMinutes)}.`
    };
  }

  if (parsed.type === "follow_player") {
    npc.moveControl = {
      mode: "follow_player",
      playerId: player.playerId
    };
    npc.holdUntil = 0;
    return { ok: true, message: `${npc.name} will follow you.` };
  }

  if (parsed.type === "hold") {
    npc.moveControl = { mode: "hold" };
    npc.target = null;
    return { ok: true, message: `${npc.name} will hold position.` };
  }

  if (parsed.type === "keep_distance") {
    npc.moveControl = {
      mode: "keep_distance",
      playerId: player.playerId,
      distance: 110
    };
    npc.holdUntil = 0;
    return { ok: true, message: `${npc.name} will keep some distance from you.` };
  }

  if (parsed.type === "go_player_home") {
    const farm = world.farms.get(player.playerId);
    if (!farm?.home) {
      return { ok: false, message: "Couldn't find your house location yet." };
    }
    npc.moveControl = {
      mode: "point",
      x: farm.home.x,
      y: farm.home.y,
      label: "your house"
    };
    npc.target = { x: farm.home.x, y: farm.home.y };
    npc.holdUntil = 0;
    return { ok: true, message: `${npc.name} is heading to your house.` };
  }

  if (parsed.type === "go_area" || parsed.type === "patrol_area") {
    const area = findAreaByNameLike(parsed.areaName);
    if (!area) {
      return { ok: false, message: `Couldn't find area "${parsed.areaName}".` };
    }
    let untilMinutes;
    let untilDay;
    if (Number.isFinite(parsed.durationMinutes) && parsed.durationMinutes > 0) {
      const until = addClockDuration(world.dayNumber, world.timeMinutes, parsed.durationMinutes);
      untilMinutes = until.timeMinutes;
      untilDay = until.dayNumber;
    }
    npc.moveControl = {
      mode: "area",
      areaName: area.name,
      patrol: parsed.type === "patrol_area",
      untilMinutes,
      untilDay
    };
    npc.holdUntil = 0;
    if (!npc.moveControl.patrol) {
      npc.target = { x: area.x + area.w / 2, y: area.y + area.h / 2 };
    }
    const durationText =
      Number.isFinite(parsed.durationMinutes) && parsed.durationMinutes > 0
        ? ` for ${formatDurationLabel(parsed.durationMinutes)} (until ${formatMinutesClock(untilMinutes)})`
        : "";
    return {
      ok: true,
      message:
        parsed.type === "patrol_area"
          ? `${npc.name} will patrol ${area.name}${durationText}.`
          : `${npc.name} is heading to ${area.name}${durationText}.`
    };
  }

  return { ok: false, message: "Unsupported movement command." };
}

function queueNpcTask({ npc, assignedByPlayerId, assignedByPlayerName, parsed }) {
  if (!npc || !parsed || !parsed.type) {
    return { ok: false, error: "Invalid task request." };
  }
  if (!Array.isArray(npc.tasks)) npc.tasks = [];
  if (npc.tasks.length >= 4) {
    return { ok: false, error: `${npc.name} is already busy with other requests.` };
  }

  if (parsed.type === "talk_to_npc") {
    const targetNpc = findNpcByNameLike(parsed.targetNpcName);
    if (!targetNpc) {
      return { ok: false, error: `Couldn't find "${parsed.targetNpcName}" in town.` };
    }
    if (targetNpc.id === npc.id) {
      return { ok: false, error: `${npc.name} cannot be asked to talk to themselves.` };
    }
    const task = {
      id: `task_${Date.now()}_${Math.floor(Math.random() * 10000)}`,
      type: "talk_to_npc",
      status: "pending",
      targetNpcId: targetNpc.id,
      topic: String(parsed.topic || "").slice(0, 180),
      assignedByPlayerId,
      assignedByPlayerName,
      createdAt: Date.now()
    };
    npc.tasks.push(task);
    return { ok: true, message: `${npc.name} will talk to ${targetNpc.name} about "${task.topic}".` };
  }

  if (parsed.type === "observe_area") {
    const areaText = cleanForMatch(parsed.areaName);
    const isAnywhere =
      !areaText || areaText === "anywhere" || areaText === "around town" || areaText === "town";
    const area = isAnywhere ? null : findAreaByNameLike(parsed.areaName);
    if (!isAnywhere && !area) {
      return { ok: false, error: `Couldn't find area "${parsed.areaName}". Try 'anywhere'.` };
    }
    const atMinutes = parsed.atTimeText ? parseTimeExpression(parsed.atTimeText) : null;
    const scheduleDay =
      Number.isFinite(atMinutes) && atMinutes <= world.timeMinutes ? world.dayNumber + 1 : world.dayNumber;

    const task = {
      id: `task_${Date.now()}_${Math.floor(Math.random() * 10000)}`,
      type: "observe_area",
      status: "pending",
      areaName: area ? area.name : null,
      atMinutes: Number.isFinite(atMinutes) ? atMinutes : null,
      durationMinutes: Math.max(10, Math.min(6 * 60, Number(parsed.durationMinutes) || 60)),
      scheduleDay,
      assignedByPlayerId,
      assignedByPlayerName,
      createdAt: Date.now()
    };
    npc.tasks.push(task);
    const whenText = Number.isFinite(task.atMinutes) ? ` at ${formatMinutesClock(task.atMinutes)}` : " now";
    const durationText = ` for ${formatDurationLabel(task.durationMinutes)}`;
    const areaLabel = area ? area.name : "around town";
    return { ok: true, message: `${npc.name} will observe ${areaLabel}${whenText}${durationText}.` };
  }

  return { ok: false, error: "Unsupported task type." };
}

function handleNpcTaskCommand({ socket, player, text, preferredNpcId = null }) {
  const parsed = parseNpcTaskCommand(text);
  if (!parsed) return { handled: false };

  const preferredNpc = preferredNpcId ? world.npcs.find((n) => n.id === preferredNpcId) || null : null;
  const npc = preferredNpc || nearestNpcToPlayer(player);
  if (!npc) {
    socket.emit("farm_feedback", {
      ok: false,
      message: "No nearby NPC to assign that request. Stand near someone first."
    });
    return { handled: true };
  }

  const queued = queueNpcTask({
    npc,
    assignedByPlayerId: player.playerId,
    assignedByPlayerName: player.name || "Traveler",
    parsed
  });
  const responseText = queued.ok ? `${queued.message} I'll report back.` : `${queued.error}`;
  io.emit("dialogue_event", {
    type: "npc_to_player",
    speakerId: npc.id,
    speakerName: npc.name,
    targetId: socket.id,
    targetName: "You",
    text: responseText,
    emotion: queued.ok ? "focused" : "neutral",
    x: npc.x,
    y: npc.y,
    timeLabel: snapshotWorld(world).timeLabel,
    needsContinue: false,
    waitingForReply: true,
    dialogueTurn: 1,
    dialogueMax: 1
  });
  socket.emit("dialogue_waiting_reply", { npcId: npc.id, npcName: npc.name });
  return { handled: true };
}

function handleNpcMovementCommand({ socket, player, text, preferredNpcId = null }) {
  const parsed = parseNpcMovementCommand(text);
  if (!parsed) return { handled: false };

  const preferredNpc = preferredNpcId ? world.npcs.find((n) => n.id === preferredNpcId) || null : null;
  const npc = preferredNpc || nearestNpcToPlayer(player);
  if (!npc) {
    socket.emit("farm_feedback", {
      ok: false,
      message: "No nearby NPC to command. Stand near someone first."
    });
    return { handled: true };
  }

  const applied = applyNpcMovementControl({ npc, player, parsed });
  io.emit("dialogue_event", {
    type: "npc_to_player",
    speakerId: npc.id,
    speakerName: npc.name,
    targetId: socket.id,
    targetName: "You",
    text: applied.message,
    emotion: applied.ok ? "focused" : "neutral",
    x: npc.x,
    y: npc.y,
    timeLabel: snapshotWorld(world).timeLabel,
    needsContinue: false,
    waitingForReply: true,
    dialogueTurn: 1,
    dialogueMax: 1
  });
  socket.emit("dialogue_waiting_reply", { npcId: npc.id, npcName: npc.name });
  emitWorldToPlayer(socket.id, "world_tick");
  return { handled: true };
}

function normalizeUsername(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, "")
    .slice(0, 24);
}

function pickRandom(arr) {
  if (!Array.isArray(arr) || arr.length === 0) return "";
  return arr[Math.floor(Math.random() * arr.length)];
}

function safeClone(value, fallback = null) {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return fallback;
  }
}

function captureConnectedPlayerProfile(player) {
  if (!player?.playerId) return null;
  const farm = world.farms.get(player.playerId);
  return {
    playerId: player.playerId,
    name: player.name || "Traveler",
    gender: player.gender || "unspecified",
    x: Number.isFinite(player.x) ? player.x : 680,
    y: Number.isFinite(player.y) ? player.y : 220,
    missionProgress: safeClone(player.missionProgress, null),
    reputation: safeClone(player.reputation, null),
    farm: safeClone(farm, null)
  };
}

function refreshPersistedProfile(player) {
  const snapshot = captureConnectedPlayerProfile(player);
  if (!snapshot?.playerId) return;
  persistedProfiles.set(snapshot.playerId, snapshot);
}

function normalizeNpcForLoad(seedNpc, loadedNpc) {
  const next = { ...seedNpc };
  const src = loadedNpc && typeof loadedNpc === "object" ? loadedNpc : {};
  if (Number.isFinite(src.x)) next.x = src.x;
  if (Number.isFinite(src.y)) next.y = src.y;
  if (Number.isFinite(src.vx)) next.vx = src.vx;
  if (Number.isFinite(src.vy)) next.vy = src.vy;
  if (Number.isFinite(src.speed)) next.speed = src.speed;
  if (Number.isFinite(src.talkCooldownUntil)) next.talkCooldownUntil = src.talkCooldownUntil;
  if (Number.isFinite(src.holdUntil)) next.holdUntil = src.holdUntil;
  if (typeof src.area === "string" && src.area.trim()) next.area = src.area;
  if (src.characterProfile && typeof src.characterProfile === "object") {
    next.characterProfile = src.characterProfile;
  }
  if (src.routineState && typeof src.routineState === "object") {
    next.routineState = src.routineState;
  }
  if (src.target && Number.isFinite(src.target.x) && Number.isFinite(src.target.y)) {
    next.target = { x: src.target.x, y: src.target.y };
  }
  next.playerNearby = Boolean(src.playerNearby);
  next.tasks = Array.isArray(src.tasks) ? src.tasks.slice(0, 6) : [];
  next.moveControl = src.moveControl && typeof src.moveControl === "object" ? src.moveControl : null;
  return next;
}

async function loadAutosave() {
  try {
    const raw = await readFile(SAVE_PATH, "utf-8");
    const data = JSON.parse(raw);
    if (!data || typeof data !== "object") return false;

    if (Number.isFinite(data.dayNumber)) world.dayNumber = data.dayNumber;
    if (Number.isFinite(data.timeMinutes)) world.timeMinutes = data.timeMinutes;
    if (typeof data.weather === "string") world.weather = data.weather;
    if (typeof data.rumorOfTheDay === "string") world.rumorOfTheDay = data.rumorOfTheDay;
    if (Array.isArray(data.dailyTownLog)) world.dailyTownLog = data.dailyTownLog.slice(-80);
    if (Array.isArray(data.yesterdayTownLog)) world.yesterdayTownLog = data.yesterdayTownLog.slice(-80);
    if (data.townMission && typeof data.townMission === "object") {
      setTownMission(world, data.townMission);
    }
    if (data.storyArc && typeof data.storyArc === "object") {
      setStoryArc(world, data.storyArc);
    }
    if (data.worldEvents && typeof data.worldEvents === "object") {
      setWorldEvents(world, data.worldEvents);
    }
    if (data.factions && typeof data.factions === "object") {
      setFactionState(world, data.factions);
    }
    if (data.rumorState && typeof data.rumorState === "object") {
      setRumorState(world, data.rumorState);
    }
    if (data.economy && typeof data.economy === "object") {
      setEconomyState(world, data.economy);
    }
    if (data.routineNudges && typeof data.routineNudges === "object") {
      const loadedNudges = Object.entries(data.routineNudges).map(([role, cfg]) => ({
        role,
        ...(cfg && typeof cfg === "object" ? cfg : {})
      }));
      setRoutineNudges(world, loadedNudges);
    }
    hydrateNpcRelations(world, data.npcRelations);

    const loadedNpcById = new Map((Array.isArray(data.npcs) ? data.npcs : []).map((n) => [n.id, n]));
    world.npcs = world.npcs.map((seedNpc) => normalizeNpcForLoad(seedNpc, loadedNpcById.get(seedNpc.id)));

    world.farms.clear();
    const farmsObj = data.farms && typeof data.farms === "object" ? data.farms : {};
    for (const [ownerId, farm] of Object.entries(farmsObj)) {
      if (!ownerId || !farm || typeof farm !== "object") continue;
      world.farms.set(ownerId, farm);
    }

    persistedProfiles.clear();
    const profilesObj = data.persistedProfiles && typeof data.persistedProfiles === "object" ? data.persistedProfiles : {};
    for (const [playerId, profile] of Object.entries(profilesObj)) {
      if (!playerId || !profile || typeof profile !== "object") continue;
      persistedProfiles.set(playerId, profile);
    }
    return true;
  } catch {
    return false;
  }
}

async function saveAutosave() {
  if (autosaveInProgress) return;
  autosaveInProgress = true;
  try {
    for (const player of world.players.values()) {
      refreshPersistedProfile(player);
    }

    const farmsObject = {};
    for (const [ownerId, farm] of world.farms.entries()) {
      farmsObject[ownerId] = safeClone(farm, null);
    }
    const profilesObject = {};
    for (const [playerId, profile] of persistedProfiles.entries()) {
      profilesObject[playerId] = safeClone(profile, null);
    }

    const payload = {
      version: 1,
      savedAt: new Date().toISOString(),
      dayNumber: world.dayNumber,
      timeMinutes: world.timeMinutes,
      weather: world.weather,
      rumorOfTheDay: world.rumorOfTheDay,
      dailyTownLog: world.dailyTownLog,
      yesterdayTownLog: world.yesterdayTownLog,
      townMission: safeClone(world.townMission, null),
      storyArc: safeClone(world.storyArc, null),
      worldEvents: safeClone(world.worldEvents, null),
      factions: safeClone(world.factions, null),
      rumorState: safeClone(world.rumorState, null),
      economy: safeClone(world.economy, null),
      routineNudges: safeClone(world.routineNudges, {}),
      npcRelations: safeClone(world.npcRelations, {}),
      npcs: safeClone(world.npcs, []),
      farms: farmsObject,
      persistedProfiles: profilesObject
    };

    await mkdir(SAVE_DIR, { recursive: true });
    await writeFile(SAVE_PATH, JSON.stringify(payload, null, 2), "utf-8");
  } catch (err) {
    console.error("autosave error:", err.message);
  } finally {
    autosaveInProgress = false;
  }
}

async function applyAiNpcRelationshipShift({ speaker, target, lineText, contextHint }) {
  if (!speaker || !target || !lineText) return null;
  const shift = await analyzeRelationshipShiftWithGuard({
    speaker: { name: speaker.name, role: speaker.role },
    target: { name: target.name, role: target.role },
    line: lineText,
    contextHint
  });
  const delta = Number(shift?.delta) || 0;
  if (!delta) return null;
  return bumpNpcRelation(
    world,
    speaker.id,
    target.id,
    delta,
    String(shift?.rationale || contextHint || "recent interaction")
  );
}

function computeQuestSignals() {
  const logs = [...(world.yesterdayTownLog || []), ...(world.dailyTownLog || [])].slice(-40);
  const rumor = rumorHotspots(world);
  const areaCounts = new Map();
  const roleCounts = new Map();
  const urgencyWords = ["tense", "restless", "fight", "storm", "shortage", "missing", "fear", "panic"];
  let urgencyHits = 0;

  for (const line of logs) {
    const text = cleanForMatch(line);
    for (const area of AREAS) {
      const areaName = cleanForMatch(area.name);
      if (text.includes(areaName)) {
        areaCounts.set(area.name, (areaCounts.get(area.name) || 0) + 1);
      }
    }
    for (const role of [...new Set(world.npcs.map((npc) => npc.role))]) {
      const roleName = cleanForMatch(role);
      if (text.includes(roleName)) {
        roleCounts.set(role, (roleCounts.get(role) || 0) + 1);
      }
    }
    for (const word of urgencyWords) {
      if (text.includes(word)) urgencyHits += 1;
    }
  }

  const logHotArea = [...areaCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || "";
  const logHotRole = [...roleCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || "";
  const hotArea = logHotArea || rumor.area || "";
  const hotRole = logHotRole || rumor.role || "";
  const urgencyFromLogs = urgencyHits >= 5 ? 3 : urgencyHits >= 2 ? 2 : 1;
  const urgencyFromRumor = Number(rumor.intensity) >= 55 ? 3 : Number(rumor.intensity) >= 28 ? 2 : 1;
  const urgency = Math.max(urgencyFromLogs, urgencyFromRumor);
  return {
    hotArea,
    hotRole,
    urgency,
    rumorIntensity: Number(rumor.intensity) || 0,
    rumorTopics: rumor.topics || [],
    logSampleSize: logs.length
  };
}

function normalizeDynamicMissionSpec(generated, signals = null) {
  const objectiveType = String(generated?.objectiveType || "")
    .trim()
    .toLowerCase();
  const validAreaNames = new Set(AREAS.map((a) => a.name));
  const validRoles = [...new Set(world.npcs.map((npc) => npc.role))];
  const missionBase = {
    id: `dynamic_${world.dayNumber}_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
    title: String(generated?.title || "Town Threads").slice(0, 60),
    description: String(generated?.description || "Follow the latest town chatter.").slice(0, 180),
    objectiveType,
    urgency: Math.max(1, Math.min(3, Number(generated?.urgency) || Number(signals?.urgency) || 1)),
    whyNow: String(generated?.whyNow || "").slice(0, 140)
  };

  if (objectiveType === "talk_npc") {
    const npc = findNpcByNameLike(generated?.targetNpcName) || pickRandom(world.npcs);
    return {
      ...missionBase,
      objectiveType: "talk_npc",
      targetNpcId: npc?.id || "npc_guard",
      title: missionBase.title || `Find ${npc?.name || "a townsfolk"}`
    };
  }
  if (objectiveType === "talk_role") {
    const requestedRole = String(generated?.targetRole || "").trim();
    const signalRole = String(signals?.hotRole || "").trim();
    const role =
      validRoles.find((r) => cleanForMatch(r) === cleanForMatch(requestedRole)) ||
      validRoles.find((r) => cleanForMatch(r) === cleanForMatch(signalRole)) ||
      pickRandom(validRoles);
    return {
      ...missionBase,
      objectiveType: "talk_role",
      targetRole: role || "Town Guard"
    };
  }
  if (objectiveType === "visit_area") {
    const requestedArea = String(generated?.targetArea || "").trim();
    const signalArea = String(signals?.hotArea || "").trim();
    const areaName = validAreaNames.has(requestedArea)
      ? requestedArea
      : validAreaNames.has(signalArea)
        ? signalArea
        : pickRandom(AREAS)?.name || "Town Square";
    return {
      ...missionBase,
      objectiveType: "visit_area",
      targetArea: areaName
    };
  }
  if (objectiveType === "harvest_count") {
    return {
      ...missionBase,
      objectiveType: "harvest_count",
      targetCount: Math.max(1, Math.min(5, Number(generated?.targetCount) || 2))
    };
  }
  if (objectiveType === "visit_unique_areas") {
    return {
      ...missionBase,
      objectiveType: "visit_unique_areas",
      targetCount: Math.max(2, Math.min(5, Number(generated?.targetCount) || 3))
    };
  }
  return {
    ...missionBase,
    objectiveType: "talk_unique_npcs",
    targetCount: Math.max(2, Math.min(5, Number(generated?.targetCount) || 2))
  };
}

async function assignDynamicMissionToPlayer(player) {
  if (!player) return null;
  const context = snapshotWorld(world);
  const townLog = [...(world.yesterdayTownLog || []), ...(world.dailyTownLog || [])].slice(-30);
  const npcs = world.npcs.map((npc) => ({
    id: npc.id,
    name: npc.name,
    role: npc.role,
    area: npc.area
  }));
  const areaNames = [...new Set(AREAS.map((a) => a.name))];
  const roleNames = [...new Set(world.npcs.map((npc) => npc.role))];
  const questSignals = computeQuestSignals();

  let generated = null;
  try {
    generated = await dialogueService.generateStoryMission({
      worldContext: context,
      townLog,
      npcs,
      areaNames,
      roleNames,
      questSignals
    });
  } catch (err) {
    console.error("dynamic mission generation error:", err.message);
  }

  const normalized = normalizeDynamicMissionSpec(generated, questSignals);
  const urgencyMultiplier = normalized.urgency >= 3 ? 1.2 : normalized.urgency === 2 ? 1.1 : 1;
  const baseReward = missionRewardCoins(world, normalized);
  normalized.rewardCoins = Math.max(1, Math.round(baseReward * urgencyMultiplier));
  const assigned = setPlayerDynamicMission(player, normalized);
  refreshPersistedProfile(player);
  return assigned;
}

async function applyMissionProgressAndNotify(socket, player, missionEvent) {
  if (!socket || !player || !missionEvent) return false;
  const result = applyMissionEvent(player, missionEvent);
  if (!result?.changed) return false;

  if (result.completedMission) {
    applyPlayerReputationDelta(player, {
      delta: 2,
      reason: `completed mission: ${result.completedMission.title || "objective"}`
    });
    const farm = world.farms.get(player.playerId);
    const bonusCoins = Math.max(1, Number(result.completedMission?.rewardCoins) || missionRewardCoins(world, result.completedMission));
    if (farm && bonusCoins > 0) {
      farm.coins += bonusCoins;
    }
    const arcResult = progressStoryArc(world, String(result.completedMission?.objectiveType || ""));
    let nextMission = result.nextMission;
    const progress = ensurePlayerMissionProgress(player);
    const baseChainComplete = progress.index >= MISSION_CHAIN.length;
    if (!nextMission && baseChainComplete) {
      nextMission = await assignDynamicMissionToPlayer(player);
    }
    const nextText = nextMission ? ` Next: ${nextMission.title}.` : " All mission steps complete.";
    socket.emit("farm_feedback", {
      ok: true,
      message: `Mission complete: ${result.completedMission.title}. Reward: +${bonusCoins} coins.${nextText}`
    });
    if (arcResult?.changed && arcResult.stageAdvanced) {
      socket.emit("farm_feedback", {
        ok: true,
        message: arcResult.completed
          ? `Story arc resolved: ${arcResult.arc?.title}. ${arcResult.arc?.branchOutcome || ""}`
          : `Story arc advanced: ${arcResult.arc?.stages?.[arcResult.arc.stageIndex] || "Next chapter unlocked."}`
      });
    }
  }
  refreshPersistedProfile(player);
  emitWorldToPlayer(socket.id, "world_tick");
  return true;
}

function applyTownMissionProgressAndNotify(socket, player, missionEvent) {
  if (!socket || !player || !missionEvent) return false;
  const result = applyTownMissionEvent(world, player, missionEvent);
  if (!result?.changed) return false;

  if (result.completed) {
    socket.emit("farm_feedback", {
      ok: true,
      message: `Gossip mission complete: ${result.mission?.title || "Town request"}`
    });
  }
  emitWorldToPlayer(socket.id, "world_tick");
  return true;
}

function normalizeGender(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "male" || normalized === "female" || normalized === "non-binary") {
    return normalized;
  }
  return "unspecified";
}

function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString("hex");
}

function safeEqualHex(a, b) {
  try {
    const ba = Buffer.from(a, "hex");
    const bb = Buffer.from(b, "hex");
    if (ba.length !== bb.length) return false;
    return crypto.timingSafeEqual(ba, bb);
  } catch {
    return false;
  }
}

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.get("/world", (_req, res) => {
  res.json(snapshotWorld(world));
});

app.post("/auth/register", async (req, res) => {
  try {
    const username = normalizeUsername(req.body?.username);
    const password = String(req.body?.password || "");
    const gender = normalizeGender(req.body?.gender);

    if (!username || username.length < 3) {
      res.status(400).json({ ok: false, error: "Username must be at least 3 characters." });
      return;
    }
    if (password.length < 4) {
      res.status(400).json({ ok: false, error: "Password must be at least 4 characters." });
      return;
    }

    const existing = await getPlayerByUsername(db, username);
    if (existing) {
      res.status(409).json({ ok: false, error: "Username already exists." });
      return;
    }

    const salt = crypto.randomBytes(16).toString("hex");
    const passwordHash = hashPassword(password, salt);
    const account = await createPlayerAccount(db, {
      id: `player_${crypto.randomUUID()}`,
      username,
      gender,
      passwordSalt: salt,
      passwordHash
    });

    res.json({
      ok: true,
      profile: {
        playerId: account.id,
        name: account.username,
        gender: account.gender
      }
    });
  } catch (err) {
    console.error("register error:", err.message);
    res.status(500).json({ ok: false, error: "Failed to create account." });
  }
});

app.post("/auth/login", async (req, res) => {
  try {
    const username = normalizeUsername(req.body?.username);
    const password = String(req.body?.password || "");
    if (!username || !password) {
      res.status(400).json({ ok: false, error: "Username and password are required." });
      return;
    }

    const account = await getPlayerByUsername(db, username);
    if (!account) {
      res.status(401).json({ ok: false, error: "Invalid credentials." });
      return;
    }

    const computedHash = hashPassword(password, account.password_salt);
    if (!safeEqualHex(computedHash, account.password_hash)) {
      res.status(401).json({ ok: false, error: "Invalid credentials." });
      return;
    }

    await touchPlayerLogin(db, account.id);
    res.json({
      ok: true,
      profile: {
        playerId: account.id,
        name: account.username,
        gender: account.gender || "unspecified"
      }
    });
  } catch (err) {
    console.error("login error:", err.message);
    res.status(500).json({ ok: false, error: "Failed to load account." });
  }
});

io.on("connection", (socket) => {
  const playerIdRaw = socket.handshake.auth?.playerId;
  const nameRaw = socket.handshake.auth?.playerName;
  const genderRaw = socket.handshake.auth?.gender;
  const playerId =
    typeof playerIdRaw === "string" && playerIdRaw.trim().length > 0
      ? playerIdRaw.trim().slice(0, 120)
      : `guest_${socket.id}`;
  const playerName =
    typeof nameRaw === "string" && nameRaw.trim().length > 0
      ? nameRaw.trim().slice(0, 24)
      : "Traveler";
  const allowedGenders = new Set(["male", "female", "non-binary"]);
  const playerGender =
    typeof genderRaw === "string" && allowedGenders.has(genderRaw) ? genderRaw : "unspecified";
  const restored = persistedProfiles.get(playerId) || null;
  if (restored?.farm && typeof restored.farm === "object") {
    world.farms.set(playerId, safeClone(restored.farm, null) || createPlayerFarmIfMissing(world, playerId));
  }
  const farm = createPlayerFarmIfMissing(world, playerId);
  const spawnX = Number.isFinite(restored?.x) ? restored.x : farm.home.x;
  const spawnY = Number.isFinite(restored?.y) ? restored.y : farm.home.y;

  world.players.set(socket.id, {
    id: socket.id,
    playerId,
    name: playerName,
    gender: playerGender,
    x: spawnX,
    y: spawnY,
    sleeping: false,
    inDialogue: false,
    dialogueNpcId: null,
    dialogueTurns: 0,
    dialogueChunks: [],
    dialogueEmotion: "neutral",
    waitingForPlayerReply: false,
    waitingAnchorX: null,
    waitingAnchorY: null,
    connectedAt: Date.now(),
    missionProgress: safeClone(restored?.missionProgress, null),
    reputation: safeClone(restored?.reputation, null)
  });
  ensurePlayerMissionProgress(world.players.get(socket.id));
  ensurePlayerReputation(world.players.get(socket.id));
  refreshPersistedProfile(world.players.get(socket.id));
  socket.emit("world_snapshot", snapshotWorld(world, socket.id));
  const joinedPlayer = world.players.get(socket.id);
  if (joinedPlayer) {
    const missionProgress = ensurePlayerMissionProgress(joinedPlayer);
    const needsDynamicMission =
      missionProgress.index >= MISSION_CHAIN.length && !missionProgress.dynamicMission;
    if (needsDynamicMission) {
      assignDynamicMissionToPlayer(joinedPlayer)
        .then(() => emitWorldToPlayer(socket.id, "world_tick"))
        .catch((err) => {
          console.error("join dynamic mission error:", err.message);
        });
    }
  }

  socket.on("player_move", async (payload) => {
    const player = world.players.get(socket.id);
    if (!player) return;
    const nextX = Number(payload?.x);
    const nextY = Number(payload?.y);
    const x = Number.isFinite(nextX) ? nextX : player.x;
    const y = Number.isFinite(nextY) ? nextY : player.y;
    const moved = Math.hypot(x - player.x, y - player.y) > 0.5;

    if (player.inDialogue && !player.waitingForPlayerReply) return;
    if (player.inDialogue && player.waitingForPlayerReply) {
      if (!moved) return;
      const anchorX = Number.isFinite(player.waitingAnchorX) ? player.waitingAnchorX : player.x;
      const anchorY = Number.isFinite(player.waitingAnchorY) ? player.waitingAnchorY : player.y;
      const movedFromAnchor = Math.hypot(x - anchorX, y - anchorY);
      if (movedFromAnchor <= 2) return;

      player.x = x;
      player.y = y;
      endPlayerDialogue(player);
      socket.emit("dialogue_ended");
      return;
    }
    player.x = x;
    player.y = y;
    const areaName = areaNameAt(x, y);
    const mainChanged = await applyMissionProgressAndNotify(socket, player, {
      type: "move",
      x,
      y,
      areaName
    });
    const townChanged = applyTownMissionProgressAndNotify(socket, player, {
      type: "move",
      x,
      y,
      areaName
    });
    if (!mainChanged && !townChanged) {
      // No-op: regular world sync happens on tick.
    }
    refreshPersistedProfile(player);
  });

  socket.on("player_state", (payload) => {
    const player = world.players.get(socket.id);
    if (!player) return;
    player.sleeping = Boolean(payload?.sleeping);
  });

  socket.on("player_chat", async (payload) => {
    try {
      const player = world.players.get(socket.id);
      if (!player || player.sleeping) return;

      const text = String(payload?.text || "").trim().slice(0, 240);
      if (!text) return;
      const movementCommandAttempt = handleNpcMovementCommand({
        socket,
        player,
        text,
        preferredNpcId: player.inDialogue ? player.dialogueNpcId : null
      });
      if (movementCommandAttempt.handled) return;
      const commandAttempt = handleNpcTaskCommand({
        socket,
        player,
        text,
        preferredNpcId: player.inDialogue ? player.dialogueNpcId : null
      });
      if (commandAttempt.handled) return;
      if (!player.inDialogue && npcConversationInProgress) return;

      if (player.inDialogue && player.dialogueNpcId && player.waitingForPlayerReply) {
        const npc = world.npcs.find((n) => n.id === player.dialogueNpcId);
        if (!npc) {
          endPlayerDialogue(player);
          socket.emit("dialogue_ended");
          return;
        }
        const dist = Math.hypot(npc.x - player.x, npc.y - player.y);
        if (dist > PLAYER_NEAR_DISTANCE) {
          endPlayerDialogue(player);
          socket.emit("dialogue_ended");
          return;
        }

        io.emit("dialogue_event", {
          type: "player_chat",
          speakerId: socket.id,
          speakerName: player.name || "You",
          targetId: npc.id,
          targetName: npc.name,
          text,
          x: player.x,
          y: player.y,
          timeLabel: snapshotWorld(world).timeLabel
        });

        player.waitingForPlayerReply = false;
        const context = snapshotWorld(world, socket.id);
        const memoryCache = createMemoryFetchCache();
        const relationHints = relationHintsForNpc(world, npc.id, 2)
          .map((r) => `${r.otherId}:${r.label}`)
          .join(", ");
        const continuity = await buildPersonalContinuityHint(npc, player, memoryCache);
        const memoryCategory = await maybePersistPlayerMemoryEvent({
          npc,
          player,
          playerText: text,
          contextHint: `reply segment near ${npc.area}`
        });
        await maybePersistResolutionFromPlayerText({
          npc,
          player,
          playerText: text,
          memoryCache
        });
        const line = looksLikeObservationQuestion(text)
          ? await resolveObservationReply({ npc, player, text })
          : await dialogueService.generateNpcLine({
              speaker: npc,
              target: { id: player.playerId, name: player.name || "Traveler", role: "Visitor", traits: [] },
              worldContext: context,
              memories: await memoryCache.recent(npc.id, 4),
              topicHint:
                `reply mostly to player message tone/topic: "${text}" (can occasionally pivot naturally). ` +
                `social context: ${relationHints || "none"}. personal continuity: ${continuity}.` +
                (memoryCategory ? ` latest player event: ${memoryCategory}.` : "")
            });

        await writeMemory(db, {
          npcId: npc.id,
          type: "player_interaction",
          content: line.memoryWrite,
          importance: 4,
          tags: `${npc.role},player,${player.playerId}`,
          createdAt: new Date().toISOString()
        });
        await maybePersistResolutionFromNpcLine({
          npc,
          player,
          npcLine: line.line,
          memoryCache
        });
        const playerMoodShift = await analyzeRelationshipShiftWithGuard({
          speaker: { name: npc.name, role: npc.role },
          target: { name: player.name || "Traveler", role: "Visitor" },
          line: line.line,
          contextHint: `player chat response near ${npc.area}`
        });
        const playerDelta = Number(playerMoodShift?.delta) || 0;
        if (playerDelta !== 0) {
          await upsertRelationshipDelta(db, npc.id, player.playerId, playerDelta);
          applyPlayerReputationDelta(player, {
            role: npc.role,
            delta: playerDelta,
            reason: `dialogue tone with ${npc.name}`
          });
        }

        const chunks = splitDialogueToChunks(line.line);
        const firstChunk = chunks.shift() || line.line;
        player.dialogueTurns = 1;
        player.dialogueChunks = chunks;
        player.dialogueEmotion = line.emotion || "neutral";
        const dialogueMax = 1 + player.dialogueChunks.length;
        const needsContinue = player.dialogueChunks.length > 0;
        const waitingForReply = !needsContinue;

        emitNpcLine({
          socket,
          npc,
          context,
          linePayload: { ...line, line: firstChunk },
          dialogueTurn: player.dialogueTurns,
          dialogueMax,
          needsContinue,
          waitingForReply
        });
        player.waitingForPlayerReply = waitingForReply;
        if (waitingForReply) {
          player.waitingAnchorX = player.x;
          player.waitingAnchorY = player.y;
        }
        if (!needsContinue) {
          socket.emit("dialogue_waiting_reply", { npcId: npc.id, npcName: npc.name });
        }
        pushTownEvent(world, `${player.name} checked in with ${npc.name} near ${npc.area}.`);
        return;
      }

      if (player.inDialogue) return;

      io.emit("dialogue_event", {
        type: "player_chat",
        speakerId: socket.id,
        speakerName: player.name || "You",
        text,
        x: player.x,
        y: player.y,
        timeLabel: snapshotWorld(world).timeLabel
      });
    } catch (err) {
      console.error("player_chat error:", err.message);
    }
  });

  socket.on("player_interact_npc", async (payload) => {
    try {
      const player = world.players.get(socket.id);
      if (!player || player.sleeping) return;
      if (!player.inDialogue && anyPlayerInDialogue()) return;
      if (!player.inDialogue && npcConversationInProgress) {
        npcConversationCancelRequested = true;
      }
      const npcId = String(payload?.npcId || "").trim();
      const npc = world.npcs.find((n) => n.id === npcId);
      if (!npc) return;
      if (player.inDialogue && player.dialogueNpcId && player.dialogueNpcId !== npc.id) return;
      const isContinuing = player.inDialogue && player.dialogueNpcId === npc.id;
      // Player-initiated taps should respond immediately.

      const dist = Math.hypot(npc.x - player.x, npc.y - player.y);
      if (dist > PLAYER_NEAR_DISTANCE) return;
      await applyMissionProgressAndNotify(socket, player, { type: "talk_npc", npcId: npc.id });
      await applyMissionProgressAndNotify(socket, player, {
        type: "talk_npc_role",
        role: npc.role
      });
      applyPlayerReputationDelta(player, {
        role: npc.role,
        delta: 1,
        reason: `talked with ${npc.name}`
      });
      applyTownMissionProgressAndNotify(socket, player, {
        type: "talk_npc",
        npcId: npc.id
      });
      applyTownMissionProgressAndNotify(socket, player, {
        type: "talk_npc_role",
        role: npc.role
      });

      const context = snapshotWorld(world, socket.id);
      const memoryCache = createMemoryFetchCache();

      if (!isContinuing) {
        await startPlayerDialogue({
          socket,
          player,
          npc,
          context,
          topicHint: `casual personal talk about ${pickRandom(TOWN_LIFE_TOPIC_HINTS)}`,
          memoryCache
        });
        return;
      }

      if (!player.dialogueChunks.length && !player.waitingForPlayerReply) {
        endPlayerDialogue(player);
        socket.emit("dialogue_ended");
        return;
      }
      if (player.waitingForPlayerReply) return;

      player.dialogueTurns += 1;
      const nextText = player.dialogueChunks.shift();
      const needsContinue = player.dialogueChunks.length > 0;
      const waitingForReply = !needsContinue;
      emitNpcLine({
        socket,
        npc,
        context,
        linePayload: { line: nextText, emotion: player.dialogueEmotion },
        dialogueTurn: player.dialogueTurns,
        dialogueMax: player.dialogueTurns + player.dialogueChunks.length,
        needsContinue,
        waitingForReply
      });
      player.waitingForPlayerReply = waitingForReply;
      if (waitingForReply) {
        player.waitingAnchorX = player.x;
        player.waitingAnchorY = player.y;
      }

      if (!needsContinue) {
        socket.emit("dialogue_waiting_reply", { npcId: npc.id, npcName: npc.name });
      }
    } catch (err) {
      console.error("player_interact_npc error:", err.message);
    }
  });

  socket.on("farm_action", async (payload) => {
    const player = world.players.get(socket.id);
    const farmState = world.farms.get(player?.playerId);
    if (!player || !farmState || player.inDialogue) return;

    const plotId = Number(payload?.plotId);
    const action = String(payload?.action || "");
    const cropType = String(payload?.cropType || "");
    const plot = farmState.plots.find((p) => p.id === plotId);
    if (!plot) {
      socket.emit("farm_feedback", { ok: false, message: "Invalid plot." });
      return;
    }

    const dist = Math.hypot(plot.x - player.x, plot.y - player.y);
    if (dist > FARM_ACTION_DISTANCE) {
      socket.emit("farm_feedback", { ok: false, message: "Move closer to your home field." });
      return;
    }

    const result = applyFarmAction({ state: world, ownerId: player.playerId, action, plotId, cropType });
    socket.emit("farm_feedback", result);
    if (result?.ok && action === "harvest") {
      applyPlayerReputationDelta(player, {
        role: "Shop Owner",
        delta: 1,
        reason: "supplied fresh harvest"
      });
      applyPlayerReputationDelta(player, {
        role: "Fisherman",
        delta: 1,
        reason: "helped food supply"
      });
    }
    refreshPersistedProfile(player);
    const missionChanged =
      result?.ok && action === "harvest"
        ? [
            await applyMissionProgressAndNotify(socket, player, { type: "harvest_success" }),
            applyTownMissionProgressAndNotify(socket, player, { type: "harvest_success" })
          ].some(Boolean)
        : false;
    if (!missionChanged) {
      socket.emit("world_tick", snapshotWorld(world, socket.id));
    }
  });

  socket.on("disconnect", () => {
    const player = world.players.get(socket.id);
    if (player) {
      refreshPersistedProfile(player);
    }
    world.players.delete(socket.id);
    if (String(playerId).startsWith("guest_")) {
      persistedProfiles.delete(playerId);
      removePlayerFarm(world, playerId);
    }
  });
});

function getAwakePlayers() {
  return [...world.players.values()].filter((p) => !p.sleeping);
}

function anyPlayerInDialogue() {
  return [...world.players.values()].some((p) => p.inDialogue);
}

function anyPlayerNearNpc(npc, distance) {
  return getAwakePlayers().some((player) => Math.hypot(npc.x - player.x, npc.y - player.y) <= distance);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function introLineForNpc(npc) {
  return `Welcome. I'm ${npc.name}, the town's ${npc.role.toLowerCase()}.`;
}

function createMemoryFetchCache() {
  const cache = new Map();
  return {
    async recent(npcId, limit = 6) {
      const key = `recent:${npcId}:${limit}`;
      if (cache.has(key)) return cache.get(key);
      const rows = await getRecentMemories(db, npcId, limit);
      cache.set(key, rows);
      return rows;
    },
    async byTag(npcId, tag, limit = 6) {
      const key = `tag:${npcId}:${tag}:${limit}`;
      if (cache.has(key)) return cache.get(key);
      const rows = await getRecentMemoriesByTag(db, npcId, tag, limit);
      cache.set(key, rows);
      return rows;
    }
  };
}

function buildRelationshipAiGateKey({ speaker, target, contextHint }) {
  const s = String(speaker?.id || speaker?.name || "").trim();
  const t = String(target?.id || target?.name || "").trim();
  const c = String(contextHint || "").slice(0, 80);
  return `${s}|${t}|${c}`;
}

async function analyzeRelationshipShiftWithGuard({ speaker, target, line, contextHint }) {
  const gateKey = buildRelationshipAiGateKey({ speaker, target, contextHint });
  const allow = relationshipAiGate.allow(gateKey, RELATIONSHIP_AI_COOLDOWN_MS);
  if (!allow) {
    return { delta: 0, rationale: "cooldown" };
  }
  return dialogueService.analyzeRelationshipShift({ speaker, target, line, contextHint });
}

function playerTextResolvesPromise(text) {
  const raw = String(text || "").toLowerCase();
  if (!raw) return false;
  return /\b(done|finished|completed|i did|as promised|i brought|kept my promise|delivered)\b/.test(raw);
}

function npcLineResolvesApology(text) {
  const raw = String(text || "").toLowerCase();
  if (!raw) return false;
  return /\b(i forgive you|forgiven|apology accepted|we are good|it's alright|its alright)\b/.test(raw);
}

async function unresolvedThreadSummary(npc, player, memoryCache = null) {
  if (!npc?.id || !player?.playerId) return { unresolvedCategories: [], prioritizedThreads: [] };
  const rows = memoryCache
    ? await memoryCache.byTag(npc.id, `player:${player.playerId}`, 14)
    : await getRecentMemoriesByTag(db, npc.id, `player:${player.playerId}`, 14);
  return buildFollowupMemoryContext(rows, 6);
}

async function maybePersistResolutionFromPlayerText({ npc, player, playerText, memoryCache = null }) {
  if (!npc?.id || !player?.playerId || !playerTextResolvesPromise(playerText)) return false;
  const summary = await unresolvedThreadSummary(npc, player, memoryCache);
  if (!summary.unresolvedCategories.includes("promise")) return false;
  await writeMemory(db, {
    npcId: npc.id,
    type: "player_commitment",
    content: `Promise resolved: ${String(playerText || "").slice(0, 140)}`,
    importance: 6,
    tags: `${npc.role},player:${player.playerId},category:promise_resolved`,
    createdAt: new Date().toISOString()
  });
  return true;
}

async function maybePersistResolutionFromNpcLine({ npc, player, npcLine, memoryCache = null }) {
  if (!npc?.id || !player?.playerId || !npcLineResolvesApology(npcLine)) return false;
  const summary = await unresolvedThreadSummary(npc, player, memoryCache);
  if (!summary.unresolvedCategories.includes("apology")) return false;
  await writeMemory(db, {
    npcId: npc.id,
    type: "player_commitment",
    content: `Apology resolved: ${String(npcLine || "").slice(0, 140)}`,
    importance: 6,
    tags: `${npc.role},player:${player.playerId},category:apology_resolved`,
    createdAt: new Date().toISOString()
  });
  return true;
}

async function getDailyFollowupHint(npc, player, memoryCache = null) {
  return getOrCreateDailyFollowupHint({
    cache: dailyFollowupHintCache,
    dayNumber: world.dayNumber,
    npc,
    player,
    getMemoriesByTag: (npcId, tag, limit) =>
      memoryCache ? memoryCache.byTag(npcId, tag, limit) : getRecentMemoriesByTag(db, npcId, tag, limit),
    generateFollowup: (payload) => dialogueService.generateNextDayFollowup(payload),
    worldContext: snapshotWorld(world),
    townLog: world.yesterdayTownLog || []
  });
}

async function buildPersonalContinuityHint(npc, player, memoryCache = null) {
  if (!npc || !player?.playerId) return "none";
  const memories = memoryCache
    ? await memoryCache.byTag(npc.id, `player:${player.playerId}`, 6)
    : await getRecentMemoriesByTag(db, npc.id, `player:${player.playerId}`, 6);
  const compact = compactMemoryLines(memories, 5).slice(0, 4);
  const followup = await getDailyFollowupHint(npc, player, memoryCache);
  return composeContinuityHint({ followup, memoryLines: compact, maxLen: 360 });
}

async function maybePersistPlayerMemoryEvent({ npc, player, playerText, contextHint }) {
  if (!npc || !player?.playerId) return null;
  const classified = await dialogueService.classifyPlayerMemoryEvent({
    playerText,
    npcName: npc.name,
    contextHint
  });
  const category = String(classified?.category || "none");
  if (category === "none") return null;
  const summary = String(classified?.summary || "").trim();
  if (!summary) return null;

  await writeMemory(db, {
    npcId: npc.id,
    type: "player_commitment",
    content: summary,
    importance: Math.max(1, Math.min(9, Number(classified?.importance) || 4)),
    tags: `${npc.role},player:${player.playerId},category:${category}`,
    createdAt: new Date().toISOString()
  });
  return category;
}

function buildMorningSummary(state) {
  const logs = state.yesterdayTownLog || [];
  if (logs.length === 0) {
    return "Quiet night in town. No notable incidents were reported before dawn.";
  }
  const picks = logs
    .filter((line) => !/"|\bsaid|told|replied\b/i.test(line))
    .slice(-5);
  if (picks.length === 0) {
    return "Quiet night in town. People kept to routine with no major incidents.";
  }
  return picks.map((line, idx) => `${idx + 1}. ${line}`).join("\n");
}

async function refreshTownMission() {
  const context = snapshotWorld(world);
  const areaNames = [...new Set(world.npcs.map((npc) => npc.area))];
  const roleNames = [...new Set(world.npcs.map((npc) => npc.role))];

  try {
    const generated = await dialogueService.generateTownMission({
      worldContext: context,
      townLog: world.yesterdayTownLog || [],
      areaNames,
      roleNames
    });
    const mission = setTownMission(world, {
      ...generated,
      id: `town_${world.dayNumber}_${Date.now()}`
    });
    if (mission?.gossip) {
      world.rumorOfTheDay = mission.gossip;
    }
  } catch (err) {
    console.error("town mission generation error:", err.message);
    const mission = setTownMission(world, null);
    if (mission?.gossip) {
      world.rumorOfTheDay = mission.gossip;
    }
  }
}

async function refreshStoryArc() {
  const context = snapshotWorld(world);
  const areaNames = [...new Set(world.npcs.map((npc) => npc.area))];
  const roleNames = [...new Set(world.npcs.map((npc) => npc.role))];

  try {
    const generated = await dialogueService.generateStoryArc({
      worldContext: context,
      townLog: [...(world.yesterdayTownLog || []), ...(world.dailyTownLog || [])].slice(-30),
      areaNames,
      roleNames
    });
    setStoryArc(world, {
      ...generated,
      id: `arc_${world.dayNumber}_${Date.now()}`,
      stageIndex: 0,
      stageProgress: 0,
      stageTarget: 2,
      completed: false,
      branchOutcome: ""
    });
  } catch (err) {
    console.error("story arc generation error:", err.message);
    setStoryArc(world, null);
  }
}

async function refreshRoutineNudges() {
  const context = snapshotWorld(world);
  try {
    const nudges = await dialogueService.generateRoutineNudges({
      worldContext: context,
      townLog: [...(world.yesterdayTownLog || []), ...(world.dailyTownLog || [])].slice(-30),
      roleNames: [...new Set(world.npcs.map((npc) => npc.role))],
      areaNames: [...new Set(world.npcs.map((npc) => npc.area))]
    });
    setRoutineNudges(world, nudges);
  } catch (err) {
    console.error("routine nudge generation error:", err.message);
    setRoutineNudges(world, []);
  }
}

async function refreshEconomy() {
  const context = snapshotWorld(world);
  try {
    const plan = await dialogueService.generateEconomyPlan({
      worldContext: context,
      townLog: [...(world.yesterdayTownLog || []), ...(world.dailyTownLog || [])].slice(-30),
      cropTypes: ["turnip", "carrot", "pumpkin"]
    });
    setEconomyState(world, plan);
  } catch (err) {
    console.error("economy generation error:", err.message);
    setEconomyState(world, null);
  }
}

async function refreshWorldEvents() {
  const context = snapshotWorld(world);
  try {
    const generated = await dialogueService.generateWorldEvents({
      worldContext: context,
      townLog: [...(world.yesterdayTownLog || []), ...(world.dailyTownLog || [])].slice(-30),
      areaNames: [...new Set(AREAS.map((a) => a.name))]
    });
    const events = setWorldEvents(world, generated) || { active: [] };

    let weatherShifted = false;
    let economyBoost = 1;
    for (const evt of events.active || []) {
      if (evt.effect === "weather_shift" && !weatherShifted) {
        world.weather = world.weather === "clear" ? "rain" : "clear";
        weatherShifted = true;
      }
      if (evt.effect === "price_spike") {
        economyBoost += 0.04 * evt.severity;
      }
      if (evt.effect === "guard_alert") {
        world.rumorOfTheDay = `${world.rumorOfTheDay} Guard alert near ${evt.area || "town center"}.`.slice(0, 180);
      }
      pushTownEvent(world, `Event: ${evt.title} (${evt.area || "town"}) - ${evt.description}`);
    }
    if (economyBoost > 1) {
      setEconomyState(world, {
        ...world.economy,
        missionRewardMultiplier: Math.max(0.75, Math.min(1.35, (Number(world.economy?.missionRewardMultiplier) || 1) * economyBoost)),
        note: `Events are affecting supply lines (${events.active.length} active).`
      });
    }
  } catch (err) {
    console.error("world event generation error:", err.message);
    setWorldEvents(world, { active: [] });
  }
}

async function refreshFactionPulse() {
  const context = snapshotWorld(world);
  try {
    const pulse = await dialogueService.generateFactionPulse({
      worldContext: context,
      townLog: [...(world.yesterdayTownLog || []), ...(world.dailyTownLog || [])].slice(-30),
      factions: world.factions
    });
    setFactionState(world, pulse);
  } catch (err) {
    console.error("faction pulse generation error:", err.message);
    setFactionState(world, world.factions || null);
  }
}

function dynamicMissionHasProgress(player) {
  const progress = ensurePlayerMissionProgress(player);
  return progress.harvestCount > 0 || progress.spokenNpcIds.length > 0 || progress.spokenRoles.length > 0 || progress.visitedAreas.length > 0;
}

async function refreshReactiveMissionsForOnlinePlayers() {
  const tasks = [];
  for (const player of world.players.values()) {
    const progress = ensurePlayerMissionProgress(player);
    const inDynamicMode = progress.index >= MISSION_CHAIN.length;
    if (!inDynamicMode) continue;
    const needsNew = !progress.dynamicMission || !dynamicMissionHasProgress(player);
    if (!needsNew) continue;
    tasks.push(assignDynamicMissionToPlayer(player));
  }
  if (tasks.length === 0) return;
  await Promise.allSettled(tasks);
}

function runMorningReset(reason = "new_day") {
  const summary = buildMorningSummary(world);
  runDailyRefreshPipeline({
    clearCaches: () => {
      dailyFollowupHintCache.clear();
      relationshipAiGate.clear();
    },
    shouldRefreshStoryArc: !world.storyArc || world.storyArc.completed,
    refreshStoryArc,
    refreshTownMission,
    refreshRoutineNudges,
    refreshEconomy,
    refreshWorldEvents,
    refreshFactionPulse,
    refreshReactiveMissions: refreshReactiveMissionsForOnlinePlayers,
    onStepDone: () => {
      emitWorldToAllPlayers("world_tick");
    }
  });
  for (const [socketId, player] of world.players.entries()) {
    const farm = world.farms.get(player.playerId);
    if (farm?.home) {
      player.x = farm.home.x;
      player.y = farm.home.y;
    }
    player.sleeping = false;
    if (player.inDialogue) {
      endPlayerDialogue(player);
      io.to(socketId).emit("dialogue_ended");
    }

    const reasonLine =
      reason === "overnight_skip"
        ? "You were escorted home at 2:00 AM and woke at 6:00 AM."
        : "A new day begins in town.";
    io.to(socketId).emit("morning_news", {
      dayNumber: world.dayNumber,
      title: `Morning Ledger - Day ${world.dayNumber}`,
      text: `${reasonLine}\n\n${summary}`
    });
  }
}

function maybeSkipOvernightWindow() {
  const inSkipWindow =
    world.timeMinutes >= OVERNIGHT_SKIP_START_MINUTES && world.timeMinutes < OVERNIGHT_SKIP_END_MINUTES;
  if (!inSkipWindow) return false;
  const minutesToWake = OVERNIGHT_SKIP_END_MINUTES - world.timeMinutes;
  const skipResult = tickClock(world, minutesToWake);
  const dayChanged = Boolean(skipResult?.dayChanged);
  if (dayChanged) {
    runMorningReset("overnight_skip");
  }
  return dayChanged;
}

function endPlayerDialogue(player) {
  player.inDialogue = false;
  player.dialogueNpcId = null;
  player.dialogueTurns = 0;
  player.dialogueChunks = [];
  player.dialogueEmotion = "neutral";
  player.waitingForPlayerReply = false;
  player.waitingAnchorX = null;
  player.waitingAnchorY = null;
}

function splitDialogueToChunks(text) {
  const words = String(text || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (words.length <= DIALOGUE_CHUNK_THRESHOLD_WORDS) {
    return [String(text || "").trim()];
  }

  const chunks = [];
  for (let i = 0; i < words.length; i += DIALOGUE_CHUNK_WORDS) {
    chunks.push(words.slice(i, i + DIALOGUE_CHUNK_WORDS).join(" "));
  }
  return chunks.filter((chunk) => chunk.length > 0);
}

function emitWorldToPlayer(socketId, eventName = "world_tick") {
  io.to(socketId).emit(eventName, snapshotWorld(world, socketId));
}

function emitWorldToAllPlayers(eventName = "world_tick") {
  for (const socketId of world.players.keys()) {
    emitWorldToPlayer(socketId, eventName);
  }
}

function emitNpcLine({
  socket,
  npc,
  context,
  linePayload,
  dialogueTurn,
  dialogueMax,
  needsContinue,
  waitingForReply = false
}) {
  io.emit("dialogue_event", {
    type: "npc_to_player",
    speakerId: npc.id,
    speakerName: npc.name,
    targetId: socket.id,
    targetName: "You",
    text: linePayload.line,
    emotion: linePayload.emotion,
    x: npc.x,
    y: npc.y,
    timeLabel: context.timeLabel,
    needsContinue,
    waitingForReply,
    dialogueTurn,
    dialogueMax
  });
}

function cleanupNpcTasks(npc) {
  if (!Array.isArray(npc.tasks)) {
    npc.tasks = [];
    return;
  }
  npc.tasks = npc.tasks.filter((task) => task.status !== "completed" && task.status !== "failed");
}

function nextActiveTask(npc) {
  if (!Array.isArray(npc.tasks) || npc.tasks.length === 0) return null;
  return npc.tasks.find((task) => task.status === "pending" || task.status === "in_progress") || null;
}

function isObserveTaskReady(task) {
  if (!task || task.type !== "observe_area") return false;
  if (!Number.isFinite(task.atMinutes)) return true;
  const day = Number.isFinite(task.scheduleDay) ? task.scheduleDay : world.dayNumber;
  if (world.dayNumber > day) return true;
  if (world.dayNumber < day) return false;
  return world.timeMinutes >= task.atMinutes;
}

async function resolveObservationReply({ npc, player, text }) {
  const memories = await getRecentMemories(db, npc.id, 30);
  const askedArea = areaMentionFromText(text);
  const reports = memories
    .filter((m) => m.memory_type === "observation_report")
    .filter((m) => String(m.tags || "").includes(`player:${player.playerId}`))
    .map((m) => ({ memory: m, report: parseObservationMemory(m) }))
    .filter((item) => item.report && item.report.areaName);
  const areaFiltered = askedArea ? reports.filter((item) => item.report.areaName === askedArea) : reports;
  const candidates = areaFiltered.length > 0 ? areaFiltered : reports;
  if (candidates.length === 0) {
    return {
      line: "I haven't finished any scouting report for you yet.",
      emotion: "neutral",
      memoryWrite: `${npc.name} admitted they had no completed scouting report yet.`
    };
  }

  candidates.sort((a, b) => new Date(b.memory.created_at).getTime() - new Date(a.memory.created_at).getTime());
  const best = candidates[0].report;
  return {
    line: buildObservationReplyLine(npc, best),
    emotion: "focused",
    memoryWrite: `${npc.name} reported observations from ${best.areaName} to ${player.name}.`
  };
}

async function maybeProcessNpcTasks() {
  if (npcTaskInProgress || npcConversationInProgress || anyPlayerInDialogue()) return false;
  const now = Date.now();
  const memoryCache = createMemoryFetchCache();

  for (const npc of world.npcs) {
    cleanupNpcTasks(npc);
    const task = nextActiveTask(npc);
    if (!task) continue;

    if (task.type === "observe_area") {
      if (!isObserveTaskReady(task)) continue;
      task.status = "in_progress";
      npc.routineState = {
        phase: "task_observe",
        venueType: "observe",
        areaName: task.areaName || npc.area,
        isHoliday: false
      };
      const targetAreaName = task.areaName || npc.area;
      const area = AREAS.find((a) => a.name === targetAreaName);
      if (!area) {
        task.status = "failed";
        notifyPlayerByPlayerId(task.assignedByPlayerId, `${npc.name} could not find ${targetAreaName}.`, false);
        cleanupNpcTasks(npc);
        return true;
      }

      if (npc.area !== area.name) {
        npc.target = {
          x: area.x + area.w / 2 + (Math.random() * 30 - 15),
          y: area.y + area.h / 2 + (Math.random() * 30 - 15)
        };
        return false;
      }

      const nowAbs = clockMomentToAbsolute(world.dayNumber, world.timeMinutes);
      if (!Number.isFinite(task.observeStartedAtAbs)) {
        task.observeStartedAtAbs = nowAbs;
        task.observeStartedDay = world.dayNumber;
        task.observeStartedMinutes = world.timeMinutes;
        return false;
      }

      const plannedDuration = Math.max(10, Number(task.durationMinutes) || 60);
      const elapsed = nowAbs - task.observeStartedAtAbs;
      if (elapsed < plannedDuration) {
        npc.target = {
          x: area.x + area.w / 2 + (Math.random() * 24 - 12),
          y: area.y + area.h / 2 + (Math.random() * 24 - 12)
        };
        return false;
      }

      const seenNpcs = world.npcs
        .filter((other) => other.id !== npc.id && other.area === area.name)
        .slice(0, 6);
      const peopleSeen = seenNpcs.map((other) => `${other.name} (${other.role})`);
      const buildingLook = areaVisualSummary(area.name, world.timeMinutes, world.weather);
      const report = {
        areaName: area.name,
        startDayNumber: task.observeStartedDay || world.dayNumber,
        startTimeLabel: formatMinutesClock(task.observeStartedMinutes),
        endDayNumber: world.dayNumber,
        endTimeLabel: formatMinutesClock(world.timeMinutes),
        durationMinutes: plannedDuration,
        weather: world.weather,
        crowdLevel: crowdLabel(seenNpcs.length),
        peopleSeen,
        buildingLook
      };

      await writeMemory(db, {
        npcId: npc.id,
        type: "observation_report",
        content: JSON.stringify(report),
        importance: 6,
        tags: `observation,${area.name},player:${task.assignedByPlayerId}`,
        createdAt: new Date().toISOString()
      });
      task.status = "completed";
      cleanupNpcTasks(npc);
      const atText = Number.isFinite(task.atMinutes) ? ` at ${formatMinutesClock(task.atMinutes)}` : "";
      const durationText = formatDurationLabel(plannedDuration);
      pushTownEvent(world, `${npc.name} observed ${area.name}${atText} for ${durationText} and took mental notes.`);
      notifyPlayerByPlayerId(
        task.assignedByPlayerId,
        `${npc.name} finished observing ${area.name}${atText} for ${durationText}. Ask what they saw.`,
        true
      );
      return true;
    }

    if (task.type === "talk_to_npc") {
      const target = world.npcs.find((n) => n.id === task.targetNpcId);
      if (!target) {
        task.status = "failed";
        notifyPlayerByPlayerId(task.assignedByPlayerId, `${npc.name} could not find that person anymore.`, false);
        cleanupNpcTasks(npc);
        return true;
      }

      const dist = Math.hypot(npc.x - target.x, npc.y - target.y);
      if (dist > 120) {
        task.status = "in_progress";
        npc.routineState = {
          phase: "task_talk",
          venueType: "talk",
          areaName: target.area || npc.area,
          isHoliday: false
        };
        npc.target = { x: target.x, y: target.y };
        return false;
      }
      if (npc.talkCooldownUntil > now || target.talkCooldownUntil > now) {
        continue;
      }

      npcTaskInProgress = true;
      try {
        const context = snapshotWorld(world);
        const line = await dialogueService.generateNpcLine({
          speaker: npc,
          target,
          worldContext: context,
          memories: await memoryCache.recent(npc.id, 4),
          topicHint: `player-requested topic from ${task.assignedByPlayerName || "player"}: ${task.topic}`
        });

        io.emit("dialogue_event", {
          type: "npc_to_npc",
          speakerId: npc.id,
          speakerName: npc.name,
          targetId: target.id,
          targetName: target.name,
          text: line.line,
          emotion: line.emotion,
          x: npc.x,
          y: npc.y,
          timeLabel: context.timeLabel
        });
        await writeMemory(db, {
          npcId: npc.id,
          type: "conversation",
          content: line.memoryWrite || `${npc.name} discussed ${task.topic} with ${target.name}.`,
          importance: 4,
          tags: `${npc.role},${target.role},player_request`,
          createdAt: new Date().toISOString()
        });
        task.status = "completed";
        cleanupNpcTasks(npc);
        npc.talkCooldownUntil = now + NPC_COOLDOWN_MS;
        target.talkCooldownUntil = now + NPC_COOLDOWN_MS;
        pushTownEvent(world, `${npc.name} talked to ${target.name} about ${task.topic}.`);
        notifyPlayerByPlayerId(
          task.assignedByPlayerId,
          `${npc.name} spoke to ${target.name} about "${task.topic}".`,
          true
        );
        return true;
      } catch (err) {
        task.status = "failed";
        cleanupNpcTasks(npc);
        notifyPlayerByPlayerId(
          task.assignedByPlayerId,
          `${npc.name} could not complete the request right now.`,
          false
        );
        console.error("npc task error:", err.message);
        return true;
      } finally {
        npcTaskInProgress = false;
      }
    }
  }
  return false;
}

async function startPlayerDialogue({ socket, player, npc, context, topicHint, memoryCache = null }) {
  player.inDialogue = true;
  player.dialogueNpcId = npc.id;
  player.dialogueTurns = 0;
  player.dialogueChunks = [];
  player.dialogueEmotion = "neutral";

  const introduced = await hasNpcIntroducedToPlayer(db, npc.id, player.playerId);

  let linePayload;
  if (!introduced) {
    linePayload = {
      line: introLineForNpc(npc),
      emotion: "friendly",
      memoryWrite: `${npc.name} introduced themselves to the player for the first time.`
    };
    await writeMemory(db, {
      npcId: npc.id,
      type: "player_intro",
      content: linePayload.memoryWrite,
      importance: 6,
      tags: `${npc.role},player,${player.playerId}`,
      createdAt: new Date().toISOString()
    });
  } else {
    const relationHints = relationHintsForNpc(world, npc.id, 2)
      .map((r) => `${r.otherId}:${r.label}`)
      .join(", ");
    const continuity = await buildPersonalContinuityHint(npc, player, memoryCache);
    linePayload = await dialogueService.generateNpcLine({
      speaker: npc,
      target: { id: player.playerId, name: player.name || "Traveler", role: "Visitor", traits: [] },
      worldContext: context,
      memories: memoryCache ? await memoryCache.recent(npc.id, 4) : await getRecentMemories(db, npc.id, 4),
      topicHint:
        topicHint ||
        `casual personal talk about ${pickRandom(TOWN_LIFE_TOPIC_HINTS)}. social context: ${relationHints || "none"}. personal continuity: ${continuity}.`
    });
  }

  const chunks = splitDialogueToChunks(linePayload.line);
  const firstChunk = chunks.shift() || linePayload.line;
  player.dialogueTurns = 1;
  player.dialogueChunks = chunks;
  player.dialogueEmotion = linePayload.emotion || "neutral";
  const dialogueMax = 1 + player.dialogueChunks.length;
  const needsContinue = player.dialogueChunks.length > 0;
  const waitingForReply = !needsContinue;

  emitNpcLine({
    socket,
    npc,
    context,
    linePayload: { ...linePayload, line: firstChunk },
    dialogueTurn: player.dialogueTurns,
    dialogueMax,
    needsContinue,
    waitingForReply
  });

  await writeMemory(db, {
    npcId: npc.id,
    type: "player_interaction",
    content: linePayload.memoryWrite,
    importance: 5,
    tags: `${npc.role},player,${player.playerId}`,
    createdAt: new Date().toISOString()
  });
  const introShift = await analyzeRelationshipShiftWithGuard({
    speaker: { name: npc.name, role: npc.role },
    target: { name: player.name || "Traveler", role: "Visitor" },
    line: linePayload.line,
    contextHint: `first-contact interaction near ${npc.area}`
  });
  const introDelta = Number(introShift?.delta);
  await upsertRelationshipDelta(db, npc.id, player.playerId, Number.isFinite(introDelta) ? introDelta : 1);
  applyPlayerReputationDelta(player, {
    role: npc.role,
    delta: Number.isFinite(introDelta) ? introDelta : 1,
    reason: `first impression with ${npc.name}`
  });
  pushTownEvent(world, `${npc.name} met with ${player.name} near ${npc.area}.`);
  npc.talkCooldownUntil = Date.now() + NPC_COOLDOWN_MS;
  lastAutoDialogueAt = Date.now();

  player.waitingForPlayerReply = waitingForReply;
  if (waitingForReply) {
    player.waitingAnchorX = player.x;
    player.waitingAnchorY = player.y;
  }
  if (!needsContinue) {
    socket.emit("dialogue_waiting_reply", { npcId: npc.id, npcName: npc.name });
  }
}

async function maybeTriggerNpcConversation() {
  if (npcConversationInProgress || npcConversationCancelRequested) return;
  const now = Date.now();
  const pairs = findNearbyNpcPairs(world.npcs, 110).filter(
    (pair) =>
      anyPlayerNearNpc(pair.a, PLAYER_NEAR_DISTANCE) && anyPlayerNearNpc(pair.b, PLAYER_NEAR_DISTANCE)
  );
  if (pairs.length === 0) return;

  const weightedPairs = pairs.map((pair) => {
    const rel = getNpcRelationScore(world, pair.a.id, pair.b.id);
    const relationWeight = rel <= -7 ? 0.2 : rel <= -4 ? 0.6 : rel >= 6 ? 1.4 : rel >= 3 ? 1.2 : 1;
    const distanceWeight = 1 / Math.max(1, pair.dist);
    return {
      pair,
      score: relationWeight * distanceWeight * 100
    };
  });
  weightedPairs.sort((x, y) => y.score - x.score);
  const top = weightedPairs.slice(0, Math.min(5, weightedPairs.length));
  const pair = (top[Math.floor(Math.random() * top.length)] || weightedPairs[0]).pair;
  const { a, b } = pair;
  if (a.talkCooldownUntil > now || b.talkCooldownUntil > now) return;
  npcConversationInProgress = true;
  npcConversationCancelRequested = false;

  let speaker = Math.random() > 0.5 ? a : b;
  let target = speaker.id === a.id ? b : a;
  let previousLine = "";
  const context = snapshotWorld(world);
  const memoryCache = createMemoryFetchCache();
  const turns =
    NPC_NPC_MIN_TURNS + Math.floor(Math.random() * (NPC_NPC_MAX_TURNS - NPC_NPC_MIN_TURNS + 1));

  try {
    for (let i = 0; i < turns; i += 1) {
      if (npcConversationCancelRequested || anyPlayerInDialogue()) break;
      const line = await dialogueService.generateNpcLine({
        speaker,
        target,
        worldContext: context,
        memories: await memoryCache.recent(speaker.id, 4),
        topicHint:
          i === 0
            ? `casual NPC-to-NPC talk about ${pickRandom(TOWN_LIFE_TOPIC_HINTS)}. current relation=${getNpcRelationLabel(
                getNpcRelationScore(world, speaker.id, target.id)
              )}`
            : `reply to ${target.name} naturally: "${previousLine}"`
      });

      io.emit("dialogue_event", {
        type: "npc_to_npc",
        speakerId: speaker.id,
        speakerName: speaker.name,
        targetId: target.id,
        targetName: target.name,
        text: line.line,
        emotion: line.emotion,
        x: speaker.x,
        y: speaker.y,
        timeLabel: context.timeLabel
      });
      await writeMemory(db, {
        npcId: speaker.id,
        type: "conversation",
        content: line.memoryWrite,
        importance: 4,
        tags: `${speaker.role},${target.role}`,
        createdAt: new Date().toISOString()
      });
      await applyAiNpcRelationshipShift({
        speaker,
        target,
        lineText: line.line,
        contextHint: `npc conversation near ${speaker.area}`
      });
      pushTownEvent(world, `${speaker.name} and ${target.name} exchanged updates near ${speaker.area}.`);

      if (i < turns - 1) {
        await sleep(NPC_NPC_TURN_DELAY_MS);
      }
      if (npcConversationCancelRequested || anyPlayerInDialogue()) break;

      previousLine = line.line;
      const nextSpeaker = target;
      target = speaker;
      speaker = nextSpeaker;
    }

    if (!npcConversationCancelRequested) {
      a.talkCooldownUntil = now + NPC_COOLDOWN_MS;
      b.talkCooldownUntil = now + NPC_COOLDOWN_MS;
      lastAutoDialogueAt = now;
    } else {
      lastAutoDialogueAt = Date.now();
    }
  } finally {
    npcConversationInProgress = false;
    npcConversationCancelRequested = false;
  }
}

setInterval(async () => {
  tickCount += 1;
  const dialogueActive = anyPlayerInDialogue();
  const simulationPaused = dialogueActive || npcConversationInProgress || npcTaskInProgress;
  let dayChanged = false;
  let skippedNight = false;
  if (!simulationPaused) {
    const clockResult = tickClock(world, 5);
    dayChanged = Boolean(clockResult?.dayChanged);
    if (dayChanged) {
      runMorningReset("new_day");
    }
    tickNpcMovement(world, 1);
    tickFarmGrowth(world, 5);
    skippedNight = maybeSkipOvernightWindow();
    if (dayChanged || skippedNight) {
      emitWorldToAllPlayers("world_tick");
    }
  }
  const awakePlayers = getAwakePlayers();
  const shouldSync = awakePlayers.length > 0 || tickCount % SLEEP_SYNC_INTERVAL_TICKS === 0;
  if (shouldSync) {
    emitWorldToAllPlayers("world_tick");
  }

  try {
    const taskHandled = !simulationPaused ? await maybeProcessNpcTasks() : false;
    if (
      !simulationPaused &&
      !taskHandled &&
      !dayChanged &&
      !skippedNight &&
      awakePlayers.length > 0 &&
      Date.now() - lastAutoDialogueAt >= AUTO_DIALOGUE_MIN_INTERVAL_MS
    ) {
      await maybeTriggerNpcConversation();
    }
  } catch (err) {
    console.error("Simulation error:", err.message);
  }
}, 1000);

async function boot() {
  await ensureSchema(db);
  await loadAutosave();
  await refreshTownMission();
  await refreshEconomy();
  await refreshWorldEvents();
  await refreshFactionPulse();
  await refreshRoutineNudges();
  if (!world.storyArc || world.storyArc.completed) {
    await refreshStoryArc();
  }
  setInterval(() => {
    saveAutosave();
  }, AUTOSAVE_INTERVAL_MS);

  const flushAndExit = async (code = 0) => {
    try {
      await saveAutosave();
    } finally {
      process.exit(code);
    }
  };
  process.on("SIGINT", () => {
    flushAndExit(0);
  });
  process.on("SIGTERM", () => {
    flushAndExit(0);
  });

  server.listen(PORT, () => {
    console.log(`Town sim server running on http://localhost:${PORT}`);
  });
}

boot().catch((err) => {
  console.error("Failed to start server:", err);
  process.exit(1);
});
