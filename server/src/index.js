import "dotenv/config";
import express from "express";
import cors from "cors";
import http from "node:http";
import crypto from "node:crypto";
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
import {
  applyFarmAction,
  createPlayerFarmIfMissing,
  createWorldState,
  findNearbyNpcPairs,
  pushTownEvent,
  removePlayerFarm,
  snapshotWorld,
  tickClock,
  tickFarmGrowth,
  tickNpcMovement
} from "./world.js";

const PORT = Number(process.env.PORT || 3002);
const CLIENT_ORIGIN = process.env.CLIENT_ORIGIN || "http://localhost:5173";

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

function normalizeUsername(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, "")
    .slice(0, 24);
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
  const farm = createPlayerFarmIfMissing(world, socket.id);

  world.players.set(socket.id, {
    id: socket.id,
    playerId,
    name: playerName,
    gender: playerGender,
    x: farm.home.x,
    y: farm.home.y,
    sleeping: false,
    inDialogue: false,
    dialogueNpcId: null,
    dialogueTurns: 0,
    dialogueChunks: [],
    dialogueEmotion: "neutral",
    waitingForPlayerReply: false,
    waitingAnchorX: null,
    waitingAnchorY: null,
    connectedAt: Date.now()
  });
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
      if (!player.inDialogue && npcConversationInProgress) return;

      const text = String(payload?.text || "").trim().slice(0, 240);
      if (!text) return;

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
          topicHint: `reply to player message: "${text}"`
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

      const context = snapshotWorld(world, socket.id);

      if (!isContinuing) {
        await startPlayerDialogue({
          socket,
          player,
          npc,
          context,
          topicHint: "player clicked to talk"
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
    const farmState = world.farms.get(socket.id);
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

    const result = applyFarmAction({ state: world, socketId: socket.id, action, plotId, cropType });
    socket.emit("farm_feedback", result);
    socket.emit("world_tick", snapshotWorld(world, socket.id));
  });

  socket.on("disconnect", () => {
    world.players.delete(socket.id);
    removePlayerFarm(world, socket.id);
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

function runMorningReset(reason = "new_day") {
  const summary = buildMorningSummary(world);
  for (const [socketId, player] of world.players.entries()) {
    const farm = world.farms.get(socketId);
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
      topicHint: topicHint || "reply to player interaction"
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
        topicHint: i === 0 ? "current rumors and duties" : `reply to ${target.name}: "${previousLine}"`
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
  const simulationPaused = dialogueActive || npcConversationInProgress;
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
    if (
      !simulationPaused &&
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
  server.listen(PORT, () => {
    console.log(`Town sim server running on http://localhost:${PORT}`);
  });
}

boot().catch((err) => {
  console.error("Failed to start server:", err);
  process.exit(1);
});
