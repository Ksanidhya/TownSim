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
  getRecentMemories,
  hasNpcIntroducedToPlayer,
  touchPlayerLogin,
  upsertRelationshipDelta,
  writeMemory
} from "./db.js";
import { DialogueService } from "./dialogue.js";
import { AREAS } from "./constants.js";
import {
  applyTownMissionEvent,
  applyMissionEvent,
  applyFarmAction,
  areaNameAt,
  createPlayerFarmIfMissing,
  createWorldState,
  ensurePlayerMissionProgress,
  findNearbyNpcPairs,
  pushTownEvent,
  removePlayerFarm,
  setTownMission,
  snapshotWorld,
  tickClock,
  tickFarmGrowth,
  tickNpcMovement
} from "./world.js";

const PORT = Number(process.env.PORT || 3002);
const CLIENT_ORIGIN = process.env.CLIENT_ORIGIN || "http://localhost:5173";
const AUTOSAVE_INTERVAL_MS = Number(process.env.AUTOSAVE_INTERVAL_MS || 15000);
const SAVE_DIR = path.resolve(process.cwd(), "data");
const SAVE_PATH = path.join(SAVE_DIR, "world-save.json");

const app = express();
app.use(cors({ origin: CLIENT_ORIGIN }));
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: CLIENT_ORIGIN, methods: ["GET", "POST"] }
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
let lastAutoDialogueAt = 0;
let tickCount = 0;
let npcConversationInProgress = false;
let npcConversationCancelRequested = false;
let npcTaskInProgress = false;
let autosaveInProgress = false;
const persistedProfiles = new Map();
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

  const observePattern =
    /\b(?:observe|watch|check|patrol)(?:\s+(?:the\s+)?([a-zA-Z\s'.-]+?))?(?:\s+at\s+([a-zA-Z0-9:\s]+))?$/i;
  const observeMatch = raw.match(observePattern);
  if (observeMatch) {
    const areaName = String(observeMatch[1] || "").trim();
    return {
      type: "observe_area",
      areaName: areaName || "anywhere",
      atTimeText: String(observeMatch[2] || "").trim()
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

  const goMatch = raw.match(/^(?:go|move|head|walk)\s+to\s+(.+)$/i);
  if (goMatch) {
    return { type: "go_area", areaName: goMatch[1].trim() };
  }

  const patrolMatch = raw.match(/^patrol\s+(.+)$/i);
  if (patrolMatch) {
    return { type: "patrol_area", areaName: patrolMatch[1].trim() };
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
    npc.moveControl = {
      mode: "area",
      areaName: area.name,
      patrol: parsed.type === "patrol_area"
    };
    npc.holdUntil = 0;
    if (!npc.moveControl.patrol) {
      npc.target = { x: area.x + area.w / 2, y: area.y + area.h / 2 };
    }
    return {
      ok: true,
      message:
        parsed.type === "patrol_area"
          ? `${npc.name} will patrol ${area.name}.`
          : `${npc.name} is heading to ${area.name}.`
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
      scheduleDay,
      assignedByPlayerId,
      assignedByPlayerName,
      createdAt: Date.now()
    };
    npc.tasks.push(task);
    const whenText = Number.isFinite(task.atMinutes) ? ` at ${formatMinutesClock(task.atMinutes)}` : " now";
    const areaLabel = area ? area.name : "around town";
    return { ok: true, message: `${npc.name} will observe ${areaLabel}${whenText}.` };
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

function applyMissionProgressAndNotify(socket, player, missionEvent) {
  if (!socket || !player || !missionEvent) return false;
  const result = applyMissionEvent(player, missionEvent);
  if (!result?.changed) return false;

  if (result.completedMission) {
    const nextText = result.nextMission
      ? ` Next: ${result.nextMission.title}.`
      : " All mission steps complete.";
    socket.emit("farm_feedback", {
      ok: true,
      message: `Mission complete: ${result.completedMission.title}.${nextText}`
    });
  }
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
    missionProgress: safeClone(restored?.missionProgress, null)
  });
  ensurePlayerMissionProgress(world.players.get(socket.id));
  refreshPersistedProfile(world.players.get(socket.id));
  socket.emit("world_snapshot", snapshotWorld(world, socket.id));

  socket.on("player_move", (payload) => {
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
    const mainChanged = applyMissionProgressAndNotify(socket, player, { type: "move", x, y });
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
        const line = await dialogueService.generateNpcLine({
          speaker: npc,
          target: { id: player.playerId, name: player.name || "Traveler", role: "Visitor", traits: [] },
          worldContext: context,
          memories: await getRecentMemories(db, npc.id, 4),
          topicHint: `reply mostly to player message tone/topic: "${text}" (can occasionally pivot naturally)`
        });

        await writeMemory(db, {
          npcId: npc.id,
          type: "player_interaction",
          content: line.memoryWrite,
          importance: 4,
          tags: `${npc.role},player,${player.playerId}`,
          createdAt: new Date().toISOString()
        });

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
      applyMissionProgressAndNotify(socket, player, { type: "talk_npc", npcId: npc.id });
      applyTownMissionProgressAndNotify(socket, player, {
        type: "talk_npc",
        npcId: npc.id
      });
      applyTownMissionProgressAndNotify(socket, player, {
        type: "talk_npc_role",
        role: npc.role
      });

      const context = snapshotWorld(world, socket.id);

      if (!isContinuing) {
        await startPlayerDialogue({
          socket,
          player,
          npc,
          context,
          topicHint: `casual personal talk about ${pickRandom(TOWN_LIFE_TOPIC_HINTS)}`
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

  socket.on("farm_action", (payload) => {
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
    refreshPersistedProfile(player);
    const missionChanged =
      result?.ok && action === "harvest"
        ? [
            applyMissionProgressAndNotify(socket, player, { type: "harvest_success" }),
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

function runMorningReset(reason = "new_day") {
  const summary = buildMorningSummary(world);
  refreshTownMission().then(() => {
    emitWorldToAllPlayers("world_tick");
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

async function maybeProcessNpcTasks() {
  if (npcTaskInProgress || npcConversationInProgress || anyPlayerInDialogue()) return false;
  const now = Date.now();

  for (const npc of world.npcs) {
    cleanupNpcTasks(npc);
    const task = nextActiveTask(npc);
    if (!task) continue;

    if (task.type === "observe_area") {
      if (!isObserveTaskReady(task)) continue;
      task.status = "in_progress";
      if (!task.areaName) {
        task.status = "completed";
        cleanupNpcTasks(npc);
        const atText = Number.isFinite(task.atMinutes) ? ` at ${formatMinutesClock(task.atMinutes)}` : "";
        pushTownEvent(world, `${npc.name} observed ${npc.area}${atText} and took mental notes.`);
        notifyPlayerByPlayerId(
          task.assignedByPlayerId,
          `${npc.name} finished observing around town${atText}.`,
          true
        );
        return true;
      }

      const area = AREAS.find((a) => a.name === task.areaName);
      if (!area) {
        task.status = "failed";
        notifyPlayerByPlayerId(task.assignedByPlayerId, `${npc.name} could not find ${task.areaName}.`, false);
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

      task.status = "completed";
      cleanupNpcTasks(npc);
      const atText = Number.isFinite(task.atMinutes) ? ` at ${formatMinutesClock(task.atMinutes)}` : "";
      pushTownEvent(world, `${npc.name} observed ${area.name}${atText} and took mental notes.`);
      notifyPlayerByPlayerId(
        task.assignedByPlayerId,
        `${npc.name} finished observing ${area.name}${atText}.`,
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
          memories: await getRecentMemories(db, npc.id, 4),
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

async function startPlayerDialogue({ socket, player, npc, context, topicHint }) {
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
    linePayload = await dialogueService.generateNpcLine({
      speaker: npc,
      target: { id: player.playerId, name: player.name || "Traveler", role: "Visitor", traits: [] },
      worldContext: context,
      memories: await getRecentMemories(db, npc.id, 4),
      topicHint: topicHint || `casual personal talk about ${pickRandom(TOWN_LIFE_TOPIC_HINTS)}`
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
  await upsertRelationshipDelta(db, npc.id, player.playerId, 1);
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

  const pair = pairs[Math.floor(Math.random() * Math.min(3, pairs.length))];
  const { a, b } = pair;
  if (a.talkCooldownUntil > now || b.talkCooldownUntil > now) return;
  npcConversationInProgress = true;
  npcConversationCancelRequested = false;

  let speaker = Math.random() > 0.5 ? a : b;
  let target = speaker.id === a.id ? b : a;
  let previousLine = "";
  const context = snapshotWorld(world);
  const turns =
    NPC_NPC_MIN_TURNS + Math.floor(Math.random() * (NPC_NPC_MAX_TURNS - NPC_NPC_MIN_TURNS + 1));

  try {
    for (let i = 0; i < turns; i += 1) {
      if (npcConversationCancelRequested || anyPlayerInDialogue()) break;
      const line = await dialogueService.generateNpcLine({
        speaker,
        target,
        worldContext: context,
        memories: await getRecentMemories(db, speaker.id, 4),
        topicHint:
          i === 0
            ? `casual NPC-to-NPC talk about ${pickRandom(TOWN_LIFE_TOPIC_HINTS)}`
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
