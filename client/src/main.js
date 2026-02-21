import Phaser from "phaser";
import { io } from "socket.io-client";
import "./style.css";

const SERVER_URL = import.meta.env.VITE_SERVER_URL || "http://localhost:3002";
const WORLD_WIDTH = 1600;
const WORLD_HEIGHT = 1200;
const TILE = 32;
const DIALOGUE_BUBBLE_MS = 5000;
let ACTIVE_PROFILE = { playerId: "", name: "Traveler", gender: "unspecified" };

function clamp01(value) {
  return Math.max(0, Math.min(1, value));
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function mixColor(a, b, t) {
  const ta = clamp01(t);
  const ar = (a >> 16) & 0xff;
  const ag = (a >> 8) & 0xff;
  const ab = a & 0xff;
  const br = (b >> 16) & 0xff;
  const bg = (b >> 8) & 0xff;
  const bb = b & 0xff;
  const r = Math.round(lerp(ar, br, ta));
  const g = Math.round(lerp(ag, bg, ta));
  const b2 = Math.round(lerp(ab, bb, ta));
  return (r << 16) | (g << 8) | b2;
}

function getDaylightProfile(rawMinutes) {
  const total = 24 * 60;
  const minutes = ((Number(rawMinutes) || 0) % total + total) % total;
  const dawnStart = 5 * 60;
  const dayStart = 7 * 60;
  const duskStart = 16 * 60;
  const nightStart = 20 * 60;
  const colors = {
    daySky: 0x6fb0d1,
    dawnSky: 0xc28665,
    duskSky: 0x7f5f75,
    nightSky: 0x0f1828
  };

  if (minutes >= dawnStart && minutes < dayStart) {
    const t = (minutes - dawnStart) / (dayStart - dawnStart);
    return {
      phase: "dawn",
      cameraBg: mixColor(colors.nightSky, colors.daySky, t * 0.65),
      overlayColor: mixColor(0x0b1020, 0x2f1d08, t),
      overlayAlpha: lerp(0.38, 0.08, t)
    };
  }

  if (minutes >= dayStart && minutes < duskStart) {
    return {
      phase: "day",
      cameraBg: colors.daySky,
      overlayColor: 0xffffff,
      overlayAlpha: 0
    };
  }

  if (minutes >= duskStart && minutes < nightStart) {
    const t = (minutes - duskStart) / (nightStart - duskStart);
    return {
      phase: "dusk",
      cameraBg: mixColor(colors.daySky, colors.nightSky, t * 0.8),
      overlayColor: mixColor(0x5b2c08, 0x0b1020, t),
      overlayAlpha: lerp(0.05, 0.34, t)
    };
  }

  return {
    phase: "night",
    cameraBg: colors.nightSky,
    overlayColor: 0x0b1020,
    overlayAlpha: 0.42
  };
}

function getClockIcon(minutes, dayNumber = 1) {
  const phase = getDaylightProfile(minutes).phase;
  if (phase === "dawn") return "🌅";
  if (phase === "day") return dayNumber % 2 === 0 ? "🌞" : "☀";
  if (phase === "dusk") return "🌇";
  return dayNumber % 2 === 0 ? "🌜" : "🌙";
}

function hashText(value) {
  let hash = 0;
  const text = String(value || "");
  for (let i = 0; i < text.length; i += 1) {
    hash = (hash << 5) - hash + text.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash);
}

function getNpcTint(id) {
  const palette = [0x89a7ff, 0xf8aa74, 0xa8df7c, 0xe8a6ff, 0x7cd7d5, 0xf6d274];
  return palette[hashText(id) % palette.length];
}

function normalizeGender(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "male" || normalized === "female" || normalized === "non-binary") {
    return normalized;
  }
  return "unspecified";
}

async function submitAuth(payload, mode) {
  const endpoint = mode === "login" ? "/auth/login" : "/auth/register";
  const response = await fetch(`${SERVER_URL}${endpoint}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data?.ok || !data?.profile) {
    throw new Error(data?.error || "Authentication failed.");
  }
  return {
    playerId: String(data.profile.playerId || "").trim(),
    name: String(data.profile.name || "").trim().slice(0, 24),
    gender: normalizeGender(data.profile.gender)
  };
}

function collectProfile() {
  const startScreen = document.getElementById("start-screen");
  const form = document.getElementById("start-form");
  const modeInput = document.getElementById("auth-mode");
  const nameInput = document.getElementById("player-name");
  const passwordInput = document.getElementById("player-password");
  const genderLabel = document.getElementById("player-gender-label");
  const genderInput = document.getElementById("player-gender");
  const submitButton = document.getElementById("start-submit");
  const errorEl = document.getElementById("start-error");

  return new Promise((resolve) => {
    const syncModeUi = () => {
      const isLoad = modeInput.value === "login";
      genderInput.style.display = isLoad ? "none" : "";
      genderLabel.style.display = isLoad ? "none" : "";
      submitButton.textContent = isLoad ? "Load Game" : "Create & Start";
      errorEl.textContent = "";
    };
    modeInput.addEventListener("change", syncModeUi);
    syncModeUi();

    form.addEventListener(
      "submit",
      async (evt) => {
        evt.preventDefault();
        errorEl.textContent = "";

        const username = String(nameInput.value || "")
          .trim()
          .toLowerCase()
          .replace(/[^a-z0-9_]/g, "")
          .slice(0, 24);
        const password = String(passwordInput.value || "");
        if (!username || password.length < 4) {
          errorEl.textContent = "Enter valid username and password (min 4 chars).";
          return;
        }

        try {
          submitButton.disabled = true;
          const profile = await submitAuth(
            {
              username,
              password,
              gender: normalizeGender(genderInput.value)
            },
            modeInput.value
          );
          if (!profile.playerId || !profile.name) {
            errorEl.textContent = "Invalid profile data from server.";
            return;
          }
          startScreen.classList.add("hidden");
          resolve(profile);
        } catch (err) {
          errorEl.textContent = err.message || "Failed to authenticate.";
        } finally {
          submitButton.disabled = false;
        }
      },
      { once: false }
    );
  });
}

const AREAS = [
  { name: "Town Square", x: 560, y: 460, w: 480, h: 280, color: 0x5f7f58 },
  { name: "Market Street", x: 220, y: 240, w: 280, h: 420, color: 0x867148 },
  { name: "Dock", x: 1180, y: 760, w: 340, h: 300, color: 0x4f748c },
  { name: "Sanctum", x: 1060, y: 160, w: 280, h: 220, color: 0x6f616c },
  { name: "Forest", x: 120, y: 760, w: 360, h: 320, color: 0x3f6a47 },
  { name: "Housing", x: 520, y: 120, w: 420, h: 240, color: 0x6f5f4e }
];

class TownScene extends Phaser.Scene {
  constructor() {
    super("TownScene");
    this.npcSprites = new Map();
    this.bubbles = new Map();
    this.farmPlotSprites = new Map();
    this.farmData = null;
    this.selectedPlotId = null;
    this.isSleeping = false;
    this.isInDialogue = false;
    this.isDialogueHardLocked = false;
    this.activeDialogueNpcId = null;
    this.activeDialogueNpcName = "";
    this.isReadingNews = false;
    this.lightOverlay = null;
    this.lastTimePhase = "";
    this.lastWorldTimeMinutes = null;
    this.sleepSkipHideTimer = null;
  }

  init(data) {
    this.playerProfile = data?.profile || ACTIVE_PROFILE;
  }

  create() {
    this.socket = io(SERVER_URL, {
      transports: ["websocket"],
      auth: {
        playerId: this.playerProfile.playerId,
        playerName: this.playerProfile.name,
        gender: this.playerProfile.gender
      }
    });
    this.cursors = this.input.keyboard.createCursorKeys();

    this.physics.world.setBounds(0, 0, WORLD_WIDTH, WORLD_HEIGHT);
    this.createTileTextures();
    this.drawMap();
    this.createLightingLayer();
    this.applyDayNightVisuals({ timeMinutes: 8 * 60 });

    this.player = this.physics.add.image(680, 220, "spr_player");
    this.player.setDepth(24);
    this.player.body.setSize(14, 16);
    this.player.body.setCollideWorldBounds(true);

    this.playerLabel = this.add.text(this.player.x - 10, this.player.y - 26, this.playerProfile.name, {
      fontSize: "12px",
      color: "#fff"
    });

    this.cameras.main.setBounds(0, 0, WORLD_WIDTH, WORLD_HEIGHT);
    this.cameras.main.startFollow(this.player, true, 0.08, 0.08);
    this.cameras.main.setZoom(2);
    this.cameras.main.roundPixels = true;

    this.setupSocket();
    this.setupChatControls();
    this.setupFarmControls();
    this.setupDialogueKeyboardControls();
    this.updateChatTarget();
  }

  createLightingLayer() {
    this.lightOverlay = this.add.rectangle(0, 0, WORLD_WIDTH, WORLD_HEIGHT, 0x0b1020, 0.25);
    this.lightOverlay.setOrigin(0, 0);
    this.lightOverlay.setDepth(80);
  }

  createTileTextures() {
    const makeTile = (key, base, dots = []) => {
      const g = this.make.graphics({ x: 0, y: 0, add: false });
      g.fillStyle(base, 1);
      g.fillRect(0, 0, TILE, TILE);
      for (const d of dots) {
        g.fillStyle(d.color, 1);
        g.fillRect(d.x, d.y, d.w, d.h);
      }
      g.generateTexture(key, TILE, TILE);
      g.destroy();
    };

    makeTile("tile_grass_a", 0x3f6d43, [
      { x: 2, y: 3, w: 2, h: 2, color: 0x4f7f52 },
      { x: 24, y: 8, w: 2, h: 2, color: 0x355d39 },
      { x: 12, y: 20, w: 2, h: 2, color: 0x4f7f52 },
      { x: 9, y: 13, w: 1, h: 1, color: 0x7bb06a },
      { x: 26, y: 18, w: 1, h: 1, color: 0x7bb06a }
    ]);
    makeTile("tile_grass_b", 0x436f46, [
      { x: 4, y: 4, w: 2, h: 2, color: 0x518153 },
      { x: 18, y: 14, w: 2, h: 2, color: 0x345b38 },
      { x: 9, y: 23, w: 2, h: 2, color: 0x567f57 },
      { x: 25, y: 25, w: 1, h: 1, color: 0x81b06d }
    ]);
    makeTile("tile_grass_c", 0x3b673f, [
      { x: 2, y: 12, w: 2, h: 2, color: 0x4f7e53 },
      { x: 16, y: 5, w: 3, h: 2, color: 0x315537 },
      { x: 27, y: 16, w: 2, h: 2, color: 0x4a7a4f },
      { x: 11, y: 27, w: 1, h: 1, color: 0x77aa66 }
    ]);
    makeTile("tile_path_a", 0x8a784f, [
      { x: 4, y: 6, w: 2, h: 2, color: 0x756742 },
      { x: 19, y: 17, w: 2, h: 2, color: 0x9d8b5f },
      { x: 10, y: 26, w: 2, h: 2, color: 0x756742 },
      { x: 27, y: 2, w: 1, h: 1, color: 0x6a5b3c }
    ]);
    makeTile("tile_path_b", 0x85734c, [
      { x: 3, y: 5, w: 2, h: 2, color: 0x72653f },
      { x: 18, y: 16, w: 2, h: 2, color: 0x9d8d66 },
      { x: 12, y: 23, w: 2, h: 2, color: 0x715f3b },
      { x: 24, y: 9, w: 1, h: 1, color: 0xa9986c }
    ]);
    makeTile("tile_water", 0x366988, [
      { x: 5, y: 4, w: 3, h: 1, color: 0x4d8ca8 },
      { x: 17, y: 12, w: 3, h: 1, color: 0x4d8ca8 },
      { x: 9, y: 24, w: 4, h: 1, color: 0x4d8ca8 },
      { x: 24, y: 20, w: 2, h: 1, color: 0x59a0ba }
    ]);

    const block = this.make.graphics({ x: 0, y: 0, add: false });
    block.fillStyle(0x6c4536, 1);
    block.fillRect(0, 0, TILE * 2, 12);
    block.fillStyle(0x8f5d49, 1);
    block.fillRect(2, 12, TILE * 2 - 4, 6);
    block.fillStyle(0xc4af86, 1);
    block.fillRect(0, 18, TILE * 2, TILE * 2 - 18);
    block.fillStyle(0xa18966, 1);
    block.fillRect(0, 46, TILE * 2, 4);
    block.fillStyle(0x2a2a2a, 1);
    block.fillRect(26, 34, 12, 20);
    block.fillStyle(0xe4cb86, 1);
    block.fillRect(8, 30, 12, 10);
    block.fillRect(44, 30, 12, 10);
    block.generateTexture("tile_house", TILE * 2, TILE * 2);
    block.destroy();

    const tree = this.make.graphics({ x: 0, y: 0, add: false });
    tree.fillStyle(0x3a2e1f, 1);
    tree.fillRect(13, 18, 6, 12);
    tree.fillStyle(0x305f3b, 1);
    tree.fillCircle(16, 13, 10);
    tree.fillStyle(0x3f7a4a, 1);
    tree.fillCircle(12, 10, 7);
    tree.fillCircle(20, 11, 6);
    tree.generateTexture("tile_tree", TILE, TILE);
    tree.destroy();

    const shrub = this.make.graphics({ x: 0, y: 0, add: false });
    shrub.fillStyle(0x2f613b, 1);
    shrub.fillCircle(10, 18, 7);
    shrub.fillCircle(18, 18, 7);
    shrub.fillStyle(0x3f7b4a, 1);
    shrub.fillCircle(14, 14, 7);
    shrub.generateTexture("tile_shrub", TILE, TILE);
    shrub.destroy();

    const lamp = this.make.graphics({ x: 0, y: 0, add: false });
    lamp.fillStyle(0x493e2c, 1);
    lamp.fillRect(14, 12, 4, 18);
    lamp.fillStyle(0xe7c979, 1);
    lamp.fillRect(11, 8, 10, 6);
    lamp.generateTexture("tile_lamp", TILE, TILE);
    lamp.destroy();

    const player = this.make.graphics({ x: 0, y: 0, add: false });
    player.fillStyle(0x121212, 0.22);
    player.fillEllipse(8, 17, 12, 4);
    player.fillStyle(0xe8d28a, 1);
    player.fillRect(4, 3, 8, 7);
    player.fillStyle(0x6a4e35, 1);
    player.fillRect(3, 2, 10, 3);
    player.fillStyle(0x4f7294, 1);
    player.fillRect(3, 10, 10, 6);
    player.fillStyle(0x2a2a2a, 1);
    player.fillRect(3, 16, 4, 2);
    player.fillRect(9, 16, 4, 2);
    player.generateTexture("spr_player", 16, 18);
    player.destroy();

    const npc = this.make.graphics({ x: 0, y: 0, add: false });
    npc.fillStyle(0x111111, 0.2);
    npc.fillEllipse(8, 17, 12, 4);
    npc.fillStyle(0xffffff, 1);
    npc.fillRect(4, 3, 8, 7);
    npc.fillStyle(0x3d2d20, 1);
    npc.fillRect(3, 2, 10, 3);
    npc.fillStyle(0x5e6f93, 1);
    npc.fillRect(3, 10, 10, 6);
    npc.fillStyle(0x2a2a2a, 1);
    npc.fillRect(3, 16, 4, 2);
    npc.fillRect(9, 16, 4, 2);
    npc.generateTexture("spr_npc", 16, 18);
    npc.destroy();
  }

  drawMap() {
    const cols = WORLD_WIDTH / TILE;
    const rows = WORLD_HEIGHT / TILE;
    const grassKeys = ["tile_grass_a", "tile_grass_b", "tile_grass_c"];
    for (let y = 0; y < rows; y += 1) {
      for (let x = 0; x < cols; x += 1) {
        const grassKey = grassKeys[(x * 17 + y * 31) % grassKeys.length];
        this.add.image(x * TILE + TILE / 2, y * TILE + TILE / 2, grassKey).setOrigin(0.5);
      }
    }

    const riverStartCol = Math.floor(1180 / TILE);
    const riverStartRow = Math.floor(760 / TILE);
    for (let y = riverStartRow; y < rows; y += 1) {
      for (let x = riverStartCol; x < cols; x += 1) {
        this.add.image(x * TILE + TILE / 2, y * TILE + TILE / 2, "tile_water").setOrigin(0.5);
      }
    }

    const paintPath = (x, y, w, h) => {
      const sx = Math.floor(x / TILE);
      const sy = Math.floor(y / TILE);
      const ex = Math.floor((x + w) / TILE);
      const ey = Math.floor((y + h) / TILE);
      for (let iy = sy; iy <= ey; iy += 1) {
        for (let ix = sx; ix <= ex; ix += 1) {
          const pathKey = (ix + iy) % 2 === 0 ? "tile_path_a" : "tile_path_b";
          this.add.image(ix * TILE + TILE / 2, iy * TILE + TILE / 2, pathKey).setOrigin(0.5);
        }
      }
    };

    paintPath(220, 240, 280, 420);
    paintPath(560, 460, 480, 280);
    paintPath(520, 120, 420, 240);
    paintPath(1060, 160, 280, 220);

    const buildings = [
      { x: 260, y: 280 },
      { x: 300, y: 470 },
      { x: 620, y: 160 },
      { x: 760, y: 200 },
      { x: 1120, y: 210 },
      { x: 900, y: 540 }
    ];
    for (const b of buildings) {
      this.add.image(b.x + 2, b.y + 2, "tile_house").setOrigin(0.5).setTint(0x000000).setAlpha(0.18);
      this.add.image(b.x, b.y, "tile_house").setOrigin(0.5);
    }

    const treePoints = [
      [160, 810],
      [210, 860],
      [280, 940],
      [350, 1030],
      [450, 940],
      [500, 860],
      [1120, 1000],
      [1180, 960],
      [1240, 910]
    ];
    treePoints.forEach(([x, y], i) => {
      const tex = i % 3 === 0 ? "tile_shrub" : "tile_tree";
      this.add.image(x, y, tex).setDepth(6);
    });

    const lampPoints = [
      [600, 500],
      [720, 500],
      [840, 500],
      [300, 260],
      [300, 420]
    ];
    lampPoints.forEach(([x, y]) => {
      this.add.image(x, y, "tile_lamp").setDepth(7);
    });

    const homeField = this.add.rectangle(642, 292, 160, 150, 0x6b5432, 0.36);
    homeField.setStrokeStyle(1, 0xb2925a, 0.6);
    this.add.text(565, 222, "Your Home Field", {
      fontSize: "11px",
      color: "#f6e8bb",
      stroke: "#1a1a1a",
      strokeThickness: 2
    });

    AREAS.forEach((a) => {
      this.add
        .rectangle(a.x + a.w / 2, a.y + a.h / 2, a.w, a.h, a.color, 0.12)
        .setStrokeStyle(1, 0x0f0f0f, 0.25);
      this.add.text(a.x + 8, a.y + 8, a.name, {
        fontSize: "10px",
        color: "#f2edd8",
        stroke: "#1a1a1a",
        strokeThickness: 2
      });
    });

    homeField.setDepth(2);
  }

  setupSocket() {
    this.socket.on("world_snapshot", (world) => this.applyWorld(world));
    this.socket.on("world_tick", (world) => this.applyWorld(world));
    this.socket.on("dialogue_event", (evt) => this.addDialogue(evt));
    this.socket.on("morning_news", (news) => this.showMorningNews(news));
    this.socket.on("dialogue_waiting_reply", (evt) => {
      this.isInDialogue = true;
      this.isDialogueHardLocked = false;
      this.activeDialogueNpcId = evt?.npcId || this.activeDialogueNpcId;
      this.activeDialogueNpcName = evt?.npcName || this.activeDialogueNpcName;
      this.updateChatTarget();
    });
    this.socket.on("dialogue_ended", () => {
      this.isInDialogue = false;
      this.isDialogueHardLocked = false;
      this.activeDialogueNpcId = null;
      this.activeDialogueNpcName = "";
      this.updateChatTarget();
    });
    this.socket.on("farm_feedback", (evt) => {
      const feedbackEl = document.getElementById("farm-feedback");
      feedbackEl.textContent = evt?.message || "Farm updated.";
      feedbackEl.style.color = evt?.ok ? "#c2f0c8" : "#ffd7a8";
    });
  }

  setupChatControls() {
    const chatInput = document.getElementById("chat-input");
    const chatSend = document.getElementById("chat-send");
    const sleepToggle = document.getElementById("sleep-toggle");

    const sendChat = () => {
      const text = chatInput.value.trim();
      if (!text || !this.socket?.connected || this.isSleeping || this.isDialogueHardLocked) return;
      this.socket.emit("player_chat", { text });
      chatInput.value = "";
      chatInput.blur();
    };

    chatSend.addEventListener("click", sendChat);
    chatInput.addEventListener("keydown", (evt) => {
      if (evt.key === " ") {
        evt.stopPropagation();
        return;
      }
      if (evt.key === "Enter") {
        evt.preventDefault();
        sendChat();
      }
    });

    sleepToggle.addEventListener("click", () => {
      this.isSleeping = !this.isSleeping;
      sleepToggle.textContent = this.isSleeping ? "Sleep: On" : "Sleep: Off";
      if (this.socket?.connected) {
        this.socket.emit("player_state", { sleeping: this.isSleeping });
      }
    });
  }

  setupFarmControls() {
    const sowBtn = document.getElementById("farm-sow");
    const waterBtn = document.getElementById("farm-water");
    const harvestBtn = document.getElementById("farm-harvest");
    const cropSelect = document.getElementById("farm-crop");

    const sendFarmAction = (action) => {
      if (!this.socket?.connected || !this.selectedPlotId || this.isDialogueHardLocked) return;
      this.socket.emit("farm_action", {
        action,
        plotId: this.selectedPlotId,
        cropType: cropSelect.value
      });
    };

    sowBtn.addEventListener("click", () => sendFarmAction("sow"));
    waterBtn.addEventListener("click", () => sendFarmAction("water"));
    harvestBtn.addEventListener("click", () => sendFarmAction("harvest"));
  }

  setupDialogueKeyboardControls() {
    const continueDialogue = () => {
      if (!this.socket?.connected || !this.isDialogueHardLocked || !this.activeDialogueNpcId) return;
      if (this.isTypingInChat()) return;
      this.socket.emit("player_interact_npc", { npcId: this.activeDialogueNpcId });
    };

    this.input.keyboard.on("keydown-SPACE", continueDialogue);
    this.input.keyboard.on("keydown-ENTER", continueDialogue);

    const closeNews = () => {
      if (!this.isReadingNews) return;
      this.hideMorningNews();
    };
    this.input.keyboard.on("keydown-SPACE", closeNews);
    this.input.keyboard.on("keydown-ENTER", closeNews);
  }

  showMorningNews(news) {
    const popup = document.getElementById("news-popup");
    const title = document.getElementById("news-title");
    const text = document.getElementById("news-text");
    title.textContent = news?.title || "Morning Ledger";
    text.textContent = news?.text || "No updates today.";
    popup.classList.remove("hidden");
    this.isReadingNews = true;

    if (!popup.dataset.boundClose) {
      const close = () => this.hideMorningNews();
      popup.addEventListener("click", close);
      popup.addEventListener("keydown", (evt) => {
        if (evt.key === "Enter" || evt.key === " ") {
          evt.preventDefault();
          close();
        }
      });
      popup.dataset.boundClose = "1";
    }
    popup.focus();
  }

  hideMorningNews() {
    const popup = document.getElementById("news-popup");
    popup.classList.add("hidden");
    this.isReadingNews = false;
  }

  applyWorld(world) {
    this.maybeShowSleepSkip(world);
    document.getElementById("clock").textContent = `${world.timeLabel} ${getClockIcon(
      world.timeMinutes,
      world.dayNumber
    )}`;
    document.getElementById("weather").textContent = world.weather;
    const missionLabel = world.mission?.completed
      ? "Mission: All complete"
      : `Mission ${world.mission?.step || 1}/${world.mission?.total || 1}: ${world.mission?.title || "Explore town"}`;
    const missionProgress = world.mission?.progress ? ` (${world.mission.progress})` : "";
    document.getElementById("mission").textContent = `${missionLabel}${missionProgress}`;
    const townMission = world.townMission;
    const townMissionText = townMission
      ? `Town Gossip Mission: ${townMission.title} (${townMission.progress})`
      : "Town Gossip Mission: waiting...";
    document.getElementById("town-mission").textContent = townMissionText;
    this.applyDayNightVisuals(world);

    if (world.you?.name) {
      this.playerProfile.name = world.you.name;
      this.playerProfile.gender = world.you.gender || "unspecified";
      this.playerLabel.setText(world.you.name);
      document.getElementById("player-profile").textContent = `Player: ${world.you.name} (${this.playerProfile.gender})`;
    }

    if (world.you) {
      this.player.x = world.you.x;
      this.player.y = world.you.y;
    }

    this.farmData = world.farm || null;
    this.syncFarmPlots();
    this.updateFarmHud();

    const activeIds = new Set();
    for (const npc of world.npcs) {
      activeIds.add(npc.id);
      let sprite = this.npcSprites.get(npc.id);
      if (!sprite) {
        const tint = getNpcTint(npc.id);
        const body = this.add.image(npc.x, npc.y, "spr_npc").setTint(tint).setDepth(24);
        body.setInteractive({ useHandCursor: true });
        body.on("pointerdown", () => {
          if (
            !this.socket?.connected ||
            (this.isInDialogue && this.activeDialogueNpcId && this.activeDialogueNpcId !== npc.id)
          ) {
            return;
          }
          this.socket.emit("player_interact_npc", { npcId: npc.id });
        });
        const label = this.add.text(npc.x - 16, npc.y - 24, npc.name, {
          fontSize: "11px",
          color: "#fff",
          stroke: "#000",
          strokeThickness: 2
        });
        sprite = { body, label, tint, name: npc.name };
        this.npcSprites.set(npc.id, sprite);
      }
      sprite.body.x = npc.x;
      sprite.body.y = npc.y;
      const isActiveDialogueNpc = this.activeDialogueNpcId === npc.id;
      sprite.body.setTint(isActiveDialogueNpc ? 0xffe29a : sprite.tint);
      sprite.body.setScale(isActiveDialogueNpc ? 1.08 : 1);
      sprite.label.x = npc.x - 16;
      sprite.label.y = npc.y - 24;
    }

    for (const [id, sprite] of this.npcSprites.entries()) {
      if (activeIds.has(id)) continue;
      sprite.body.destroy();
      sprite.label.destroy();
      this.npcSprites.delete(id);
    }
  }

  maybeShowSleepSkip(world) {
    if (!world || !Number.isFinite(world.timeMinutes)) return;
    const previous = this.lastWorldTimeMinutes;
    this.lastWorldTimeMinutes = world.timeMinutes;
    if (!Number.isFinite(previous)) return;

    const total = 24 * 60;
    const delta = (world.timeMinutes - previous + total) % total;
    const skippedToMorning =
      previous >= 2 * 60 && previous < 6 * 60 && world.timeMinutes === 6 * 60 && delta >= 120;
    if (!skippedToMorning) return;

    const overlay = document.getElementById("sleep-skip");
    if (!overlay) return;
    overlay.classList.remove("hidden");
    if (this.sleepSkipHideTimer) {
      clearTimeout(this.sleepSkipHideTimer);
    }
    this.sleepSkipHideTimer = setTimeout(() => {
      overlay.classList.add("hidden");
      this.sleepSkipHideTimer = null;
    }, 1800);
  }

  applyDayNightVisuals(world) {
    if (!world || !Number.isFinite(world.timeMinutes)) return;
    const profile = getDaylightProfile(world.timeMinutes);
    this.cameras.main.setBackgroundColor(profile.cameraBg);
    if (this.lightOverlay) {
      this.lightOverlay.setFillStyle(profile.overlayColor, profile.overlayAlpha);
    }

    if (this.lastTimePhase !== profile.phase) {
      document.body.dataset.timePhase = profile.phase;
      this.lastTimePhase = profile.phase;
    }
  }

  plotLabel(plot) {
    if (plot.state === "empty") return "Empty";
    if (plot.state === "ready") return `${plot.cropType} ready`;
    const pct = Math.min(100, Math.round((plot.growth / Math.max(plot.growth, 1, 360)) * 100));
    return `${plot.cropType} ${pct}%`;
  }

  syncFarmPlots() {
    const liveIds = new Set();
    for (const plot of this.farmData?.plots || []) {
      liveIds.add(plot.id);
      let sprite = this.farmPlotSprites.get(plot.id);

      const fillColorByState = {
        empty: 0x7e633c,
        seeded: 0x806131,
        growing: 0x4e7d3e,
        ready: 0xc59e3f
      };
      const fill = fillColorByState[plot.state] || 0x7e633c;

      if (!sprite) {
        const soil = this.add.rectangle(plot.x, plot.y, 34, 34, fill, 0.95).setDepth(8);
        soil.setStrokeStyle(1, 0x2c2117, 0.95);
        soil.setInteractive({ useHandCursor: true });
        const label = this.add.text(plot.x - 16, plot.y - 8, `#${plot.id}`, {
          fontSize: "9px",
          color: "#f6edd0",
          stroke: "#111",
          strokeThickness: 2
        });
        label.setDepth(10);

        soil.on("pointerdown", () => {
          this.selectedPlotId = plot.id;
          this.updateFarmHud();
          this.syncFarmPlots();
        });

        sprite = { soil, label };
        this.farmPlotSprites.set(plot.id, sprite);
      }

      sprite.soil.setPosition(plot.x, plot.y);
      sprite.soil.setFillStyle(fill, 0.95);
      const selected = this.selectedPlotId === plot.id;
      sprite.soil.setStrokeStyle(selected ? 2 : 1, selected ? 0xf6e27f : 0x2c2117, 0.95);
      sprite.label.setText(`#${plot.id}`);
      sprite.label.setPosition(plot.x - 16, plot.y - 8);
    }

    for (const [plotId, sprite] of this.farmPlotSprites.entries()) {
      if (liveIds.has(plotId)) continue;
      sprite.soil.destroy();
      sprite.label.destroy();
      this.farmPlotSprites.delete(plotId);
    }

    if (this.selectedPlotId && !liveIds.has(this.selectedPlotId)) {
      this.selectedPlotId = null;
    }
  }

  selectedPlot() {
    if (!this.farmData?.plots || !this.selectedPlotId) return null;
    return this.farmData.plots.find((plot) => plot.id === this.selectedPlotId) || null;
  }

  updateFarmHud() {
    const selectedEl = document.getElementById("farm-selected");
    const coinsEl = document.getElementById("farm-coins");
    const invEl = document.getElementById("farm-inventory");

    if (!this.farmData) {
      selectedEl.textContent = "Plot: none";
      coinsEl.textContent = "Coins: 0";
      invEl.textContent = "Inventory: -";
      return;
    }

    const plot = this.selectedPlot();
    if (!plot) {
      selectedEl.textContent = "Plot: none";
    } else {
      const moisture = Math.round(plot.water || 0);
      selectedEl.textContent = `Plot ${plot.id}: ${plot.state}${plot.cropType ? ` (${plot.cropType})` : ""}, water ${moisture}%`;
    }

    coinsEl.textContent = `Coins: ${this.farmData.coins}`;
    const i = this.farmData.inventory || {};
    invEl.textContent =
      `Inventory: turnip ${i.turnip || 0}, carrot ${i.carrot || 0}, pumpkin ${i.pumpkin || 0}` +
      ` | seeds T:${i.turnip_seed || 0} C:${i.carrot_seed || 0} P:${i.pumpkin_seed || 0}`;
  }

  addDialogue(evt) {
    for (const bubble of this.bubbles.values()) {
      bubble.text.destroy();
    }
    this.bubbles.clear();

    let bubbleText = evt.text;
    if (
      evt.type === "npc_to_player" &&
      evt.targetId === this.socket?.id &&
      Number.isFinite(evt.dialogueTurn) &&
      Number.isFinite(evt.dialogueMax)
    ) {
      if (evt.dialogueMax > 1) {
        const turnText = `${evt.dialogueTurn}/${evt.dialogueMax}`;
        bubbleText = evt.needsContinue
          ? `${evt.text}\n${turnText} - tap NPC or bubble to continue`
          : `${evt.text}\n${turnText}`;
      }
      this.isInDialogue = Boolean(evt.needsContinue || evt.waitingForReply);
      this.isDialogueHardLocked = Boolean(evt.needsContinue);
      this.activeDialogueNpcId = evt.speakerId;
      this.activeDialogueNpcName = evt.speakerName || "";
      this.updateChatTarget();
    }

    const isHighlighted =
      (evt.type === "npc_to_player" && evt.targetId === this.socket?.id) ||
      (evt.type === "player_chat" && evt.speakerId === this.socket?.id);
    const bubble = this.add.text(evt.x, evt.y - 24, bubbleText, {
      fontSize: "9px",
      color: "#151515",
      backgroundColor: isHighlighted ? "#ffedbf" : "#f5f3e6",
      padding: { x: 5, y: 3 },
      wordWrap: { width: 120 },
      align: "center"
    });
    bubble.setOrigin(0.5, 1);
    bubble.setDepth(99);
    if (evt.type === "npc_to_player" && evt.targetId === this.socket?.id && evt.needsContinue) {
      bubble.setInteractive({ useHandCursor: true });
      bubble.on("pointerdown", () => {
        if (!this.socket?.connected || !this.activeDialogueNpcId) return;
        this.socket.emit("player_interact_npc", { npcId: this.activeDialogueNpcId });
      });
    }
    this.bubbles.set(evt.speakerId, { text: bubble, expiresAt: this.time.now + DIALOGUE_BUBBLE_MS });
  }

  updateDialogueBubbles() {
    for (const [speakerId, bubble] of this.bubbles.entries()) {
      if (this.time.now >= bubble.expiresAt) {
        bubble.text.destroy();
        this.bubbles.delete(speakerId);
        continue;
      }

      if (speakerId === this.socket?.id) {
        bubble.text.x = this.player.x;
        bubble.text.y = this.player.y - 26;
        continue;
      }

      const npc = this.npcSprites.get(speakerId);
      if (npc) {
        bubble.text.x = npc.body.x;
        bubble.text.y = npc.body.y - 26;
      }
    }
  }

  isTypingInChat() {
    const active = document.activeElement;
    return active && (active.id === "chat-input" || active.id === "player-name");
  }

  updateChatTarget() {
    const targetEl = document.getElementById("chat-target");
    const inputEl = document.getElementById("chat-input");
    if (this.isInDialogue && this.activeDialogueNpcName) {
      targetEl.textContent = `Talking to: ${this.activeDialogueNpcName}`;
      inputEl.placeholder = `Reply to ${this.activeDialogueNpcName}...`;
      return;
    }
    targetEl.textContent = "Talking to: nobody";
    inputEl.placeholder = "Say something...";
  }

  updateMovement() {
    if (this.isSleeping || this.isDialogueHardLocked || this.isReadingNews || this.isTypingInChat()) {
      this.player.body.setVelocity(0, 0);
      return;
    }

    const speed = 120;
    let vx = 0;
    let vy = 0;
    if (this.cursors.left.isDown) vx -= speed;
    if (this.cursors.right.isDown) vx += speed;
    if (this.cursors.up.isDown) vy -= speed;
    if (this.cursors.down.isDown) vy += speed;

    this.player.body.setVelocity(vx, vy);
    if (vx && vy) this.player.body.velocity.normalize().scale(speed);
  }

  update() {
    this.updateMovement();
    this.updateDialogueBubbles();

    this.playerLabel.x = this.player.x - 10;
    this.playerLabel.y = this.player.y - 26;

    if (this.socket?.connected) {
      this.socket.emit("player_move", { x: this.player.x, y: this.player.y });
    }
  }
}

async function startGame() {
  const profile = await collectProfile();
  ACTIVE_PROFILE = profile;
  new Phaser.Game({
    type: Phaser.AUTO,
    parent: "game-root",
    width: window.innerWidth,
    height: window.innerHeight,
    antialias: false,
    autoRound: true,
    pixelArt: true,
    backgroundColor: "#22352e",
    physics: {
      default: "arcade",
      arcade: { debug: false }
    },
    scene: [TownScene]
  });
}

startGame();
