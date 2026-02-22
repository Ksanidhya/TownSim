import Phaser from "phaser";
import { io } from "socket.io-client";
import "./style.css";

const SERVER_URL = import.meta.env.VITE_SERVER_URL || "http://localhost:3002";
const WORLD_WIDTH = 1600;
const WORLD_HEIGHT = 1200;
const TILE = 32;
const DIALOGUE_BUBBLE_MS = 5000;
const CROP_GROW_MINUTES = {
  turnip: 180,
  carrot: 240,
  pumpkin: 360
};
const HOME_FIELD_CENTER = { x: 675, y: 280 };
const HOME_FIELD_SIZE = { w: 340, h: 280 };
const FARM_TOOL_DISTANCE = 170;
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
  { name: "Housing", x: 470, y: 80, w: 530, h: 330, color: 0x6f5f4e }
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
    this.farmToolbelt = null;
    this.farmToolButtons = [];
    this.isNearFarm = false;
    this.farmPanelVisible = false;
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
    this.createFarmToolbelt();
    this.setupDialogueKeyboardControls();
    this.updateChatTarget();
    this.setFarmPanelVisible(false);
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
    block.fillStyle(0x513224, 1);
    block.fillRect(0, 2, TILE * 2, 10);
    block.fillStyle(0x69412f, 1);
    for (let rx = 0; rx < TILE * 2; rx += 8) {
      block.fillRect(rx, 12, 6, 5);
    }
    block.fillStyle(0xbcaa83, 1);
    block.fillRect(2, 18, TILE * 2 - 4, TILE * 2 - 20);
    block.fillStyle(0xcebb91, 1);
    block.fillRect(5, 22, TILE * 2 - 10, TILE * 2 - 26);
    block.fillStyle(0x7f6a46, 1);
    block.fillRect(0, 47, TILE * 2, 4);
    block.fillStyle(0x2b231a, 1);
    block.fillRect(26, 32, 12, 22);
    block.fillStyle(0xe8d194, 1);
    block.fillRect(8, 30, 12, 9);
    block.fillRect(44, 30, 12, 9);
    block.fillStyle(0x8e7d5f, 1);
    block.fillRect(13, 33, 2, 6);
    block.fillRect(49, 33, 2, 6);
    block.fillStyle(0xa5432d, 1);
    block.fillRect(46, 8, 7, 11);
    block.fillStyle(0x6e2e20, 1);
    block.fillRect(47, 6, 5, 2);
    block.fillStyle(0x39312a, 1);
    block.fillRect(0, 18, TILE * 2, 1);
    block.fillRect(0, 29, TILE * 2, 1);
    block.fillRect(0, 40, TILE * 2, 1);
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

    const pine = this.make.graphics({ x: 0, y: 0, add: false });
    pine.fillStyle(0x3b2a1d, 1);
    pine.fillRect(14, 20, 4, 10);
    pine.fillStyle(0x2e5938, 1);
    pine.fillTriangle(16, 3, 7, 17, 25, 17);
    pine.fillStyle(0x356843, 1);
    pine.fillTriangle(16, 8, 6, 21, 26, 21);
    pine.fillStyle(0x3f7650, 1);
    pine.fillTriangle(16, 13, 5, 26, 27, 26);
    pine.generateTexture("tile_pine", TILE, TILE);
    pine.destroy();

    const fern = this.make.graphics({ x: 0, y: 0, add: false });
    fern.fillStyle(0x355e3f, 1);
    fern.fillTriangle(16, 9, 8, 21, 13, 21);
    fern.fillTriangle(16, 9, 19, 21, 24, 21);
    fern.fillStyle(0x42764f, 1);
    fern.fillTriangle(16, 11, 11, 23, 16, 23);
    fern.fillTriangle(16, 11, 16, 23, 21, 23);
    fern.fillStyle(0x2f5237, 1);
    fern.fillRect(15, 22, 2, 6);
    fern.generateTexture("tile_fern", TILE, TILE);
    fern.destroy();

    const stump = this.make.graphics({ x: 0, y: 0, add: false });
    stump.fillStyle(0x4b3424, 1);
    stump.fillRoundedRect(7, 16, 18, 10, 4);
    stump.fillStyle(0x7e5a3d, 1);
    stump.fillEllipse(16, 16, 17, 6);
    stump.fillStyle(0x9a7350, 1);
    stump.fillEllipse(16, 16, 9, 3);
    stump.generateTexture("tile_stump", TILE, TILE);
    stump.destroy();

    const lamp = this.make.graphics({ x: 0, y: 0, add: false });
    lamp.fillStyle(0x493e2c, 1);
    lamp.fillRect(14, 12, 4, 18);
    lamp.fillStyle(0xe7c979, 1);
    lamp.fillRect(11, 8, 10, 6);
    lamp.generateTexture("tile_lamp", TILE, TILE);
    lamp.destroy();

    const sowTool = this.make.graphics({ x: 0, y: 0, add: false });
    sowTool.fillStyle(0x6d4b2e, 1);
    sowTool.fillRect(3, 16, 14, 3);
    sowTool.fillStyle(0x8f6b47, 1);
    sowTool.fillRect(4, 13, 8, 3);
    sowTool.fillStyle(0x9a9d9f, 1);
    sowTool.fillTriangle(15, 10, 23, 14, 15, 18);
    sowTool.generateTexture("tool_sow", 26, 26);
    sowTool.destroy();

    const waterTool = this.make.graphics({ x: 0, y: 0, add: false });
    waterTool.fillStyle(0x567c95, 1);
    waterTool.fillRoundedRect(5, 10, 14, 9, 3);
    waterTool.fillStyle(0x8cb1c4, 1);
    waterTool.fillRect(7, 8, 10, 2);
    waterTool.lineStyle(2, 0xacc8d4, 1);
    waterTool.strokeCircle(18, 13, 5);
    waterTool.fillStyle(0x86c7db, 1);
    waterTool.fillCircle(22, 19, 2);
    waterTool.generateTexture("tool_water", 26, 26);
    waterTool.destroy();

    const harvestTool = this.make.graphics({ x: 0, y: 0, add: false });
    harvestTool.fillStyle(0x7a5432, 1);
    harvestTool.fillRoundedRect(5, 11, 16, 10, 3);
    harvestTool.lineStyle(2, 0xc9a36d, 1);
    harvestTool.lineBetween(8, 11, 8, 7);
    harvestTool.lineBetween(18, 11, 18, 7);
    harvestTool.lineBetween(8, 7, 18, 7);
    harvestTool.fillStyle(0xe2be67, 1);
    harvestTool.fillCircle(10, 15, 2);
    harvestTool.fillCircle(14, 16, 2);
    harvestTool.fillCircle(17, 15, 2);
    harvestTool.generateTexture("tool_harvest", 26, 26);
    harvestTool.destroy();

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
    paintPath(470, 80, 530, 330);
    paintPath(1060, 160, 280, 220);

    const buildings = [
      { x: 260, y: 280 },
      { x: 300, y: 470 },
      { x: 620, y: 160 },
      { x: 760, y: 200 },
      { x: 1120, y: 210 },
      { x: 900, y: 540 },
      { x: 540, y: 610 },
      { x: 1040, y: 570 }
    ];
    for (const [idx, b] of buildings.entries()) {
      const colorShift = [0xffffff, 0xf8f4e6, 0xf1e7d2][idx % 3];
      this.add.image(b.x + 3, b.y + 3, "tile_house").setOrigin(0.5).setTint(0x000000).setAlpha(0.2);
      this.add.image(b.x, b.y, "tile_house").setOrigin(0.5).setTint(colorShift);
      this.add.rectangle(b.x, b.y + 30, 36, 4, 0x6f553a, 0.92).setDepth(6);
      this.add.rectangle(b.x - 14, b.y + 33, 6, 7, 0x876c4a, 0.9).setDepth(6);
      this.add.rectangle(b.x + 14, b.y + 33, 6, 7, 0x876c4a, 0.9).setDepth(6);
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
      [1240, 910],
      [120, 190],
      [170, 150],
      [1240, 150],
      [1300, 210],
      [1410, 350],
      [1450, 780],
      [1420, 1040],
      [860, 920],
      [960, 980],
      [640, 990],
      [260, 600],
      [220, 690],
      [420, 720]
    ];
    treePoints.forEach(([x, y], i) => {
      const tex = i % 3 === 0 ? "tile_shrub" : "tile_tree";
      this.add.image(x, y, tex).setDepth(6);
    });

    const shrubPoints = [
      [240, 330],
      [360, 230],
      [510, 330],
      [820, 120],
      [970, 140],
      [1150, 340],
      [1000, 720],
      [820, 810],
      [690, 710],
      [540, 820],
      [380, 880],
      [1270, 860]
    ];
    shrubPoints.forEach(([x, y]) => {
      this.add.image(x, y, "tile_shrub").setDepth(6);
    });

    const forestArea = AREAS.find((a) => a.name === "Forest");
    if (forestArea) {
      const forestLayer = this.add.graphics().setDepth(4);
      forestLayer.fillStyle(0x203126, 0.34);
      forestLayer.fillRect(forestArea.x, forestArea.y, forestArea.w, forestArea.h);
      forestLayer.fillStyle(0x2a4031, 0.2);
      for (let i = 0; i < 120; i += 1) {
        const px = forestArea.x + 8 + ((i * 37) % (forestArea.w - 16));
        const py = forestArea.y + 8 + ((i * 53) % (forestArea.h - 16));
        forestLayer.fillCircle(px, py, 3 + (i % 3));
      }

      const denseTrees = [];
      for (let row = 0; row < 6; row += 1) {
        for (let col = 0; col < 8; col += 1) {
          const x = forestArea.x + 28 + col * 42 + ((row % 2) * 10 - 5);
          const y = forestArea.y + 28 + row * 46 + ((col % 2) * 9 - 4);
          denseTrees.push([x, y]);
        }
      }
      denseTrees.forEach(([x, y], i) => {
        const isPine = i % 2 === 0;
        const tex = isPine ? "tile_pine" : "tile_tree";
        this.add.image(x + 2, y + 3, tex).setTint(0x000000).setAlpha(0.18).setDepth(6);
        this.add.image(x, y, tex).setDepth(7).setScale(isPine ? 1.02 : 1);
      });

      for (let i = 0; i < 40; i += 1) {
        const x = forestArea.x + 24 + ((i * 67) % (forestArea.w - 46));
        const y = forestArea.y + 20 + ((i * 41) % (forestArea.h - 42));
        const tex = i % 5 === 0 ? "tile_stump" : i % 2 === 0 ? "tile_fern" : "tile_shrub";
        this.add.image(x, y, tex).setDepth(6);
      }

      const trails = this.add.graphics().setDepth(5);
      trails.lineStyle(10, 0x4b5f49, 0.42);
      trails.lineBetween(forestArea.x + 30, forestArea.y + 30, forestArea.x + forestArea.w - 50, forestArea.y + forestArea.h - 40);
      trails.lineBetween(forestArea.x + 95, forestArea.y + forestArea.h - 20, forestArea.x + forestArea.w - 20, forestArea.y + 90);
      trails.lineStyle(4, 0x6c7c67, 0.25);
      trails.lineBetween(forestArea.x + 30, forestArea.y + 30, forestArea.x + forestArea.w - 50, forestArea.y + forestArea.h - 40);
      trails.lineBetween(forestArea.x + 95, forestArea.y + forestArea.h - 20, forestArea.x + forestArea.w - 20, forestArea.y + 90);

      const canopyShade = this.add.graphics().setDepth(8);
      canopyShade.fillStyle(0x102018, 0.18);
      for (let i = 0; i < 28; i += 1) {
        const x = forestArea.x + 16 + ((i * 59) % (forestArea.w - 24));
        const y = forestArea.y + 16 + ((i * 83) % (forestArea.h - 24));
        canopyShade.fillEllipse(x, y, 34 + (i % 4) * 8, 16 + (i % 3) * 7);
      }
    }

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

    const dockDeck = this.add.graphics();
    const drawDockPlanks = (x, y, w, h) => {
      dockDeck.fillStyle(0x6e4f34, 0.95);
      dockDeck.fillRect(x, y, w, h);
      for (let py = y + 3; py < y + h; py += 8) {
        dockDeck.lineStyle(1, 0x7f5e3f, 0.95);
        dockDeck.lineBetween(x + 4, py, x + w - 4, py);
      }
      for (let px = x + 14; px < x + w; px += 28) {
        dockDeck.lineStyle(1, 0x5a3f29, 0.95);
        dockDeck.lineBetween(px, y + 3, px, y + h - 3);
      }
    };
    drawDockPlanks(1202, 792, 190, 46);
    drawDockPlanks(1238, 838, 42, 155);
    for (const post of [
      [1212, 784],
      [1268, 784],
      [1324, 784],
      [1380, 784],
      [1246, 838],
      [1246, 908],
      [1246, 980],
      [1280, 980]
    ]) {
      const [x, y] = post;
      this.add.rectangle(x, y, 6, 12, 0x4f3624, 0.98).setDepth(6);
      this.add.rectangle(x, y - 4, 8, 4, 0x8c6947, 0.95).setDepth(6);
    }
    dockDeck.setDepth(5);

    const homeField = this.add.rectangle(HOME_FIELD_CENTER.x, HOME_FIELD_CENTER.y, HOME_FIELD_SIZE.w, HOME_FIELD_SIZE.h, 0x6b5432, 0.34);
    homeField.setStrokeStyle(2, 0xc1a572, 0.7);
    this.add
      .rectangle(HOME_FIELD_CENTER.x, HOME_FIELD_CENTER.y, HOME_FIELD_SIZE.w + 20, HOME_FIELD_SIZE.h + 20, 0x2d2317, 0)
      .setStrokeStyle(1, 0xdcc38c, 0.65)
      .setDepth(3);
    this.add.text(HOME_FIELD_CENTER.x - 132, HOME_FIELD_CENTER.y - 148, "Your Home Field", {
      fontSize: "11px",
      color: "#f6e8bb",
      stroke: "#1a1a1a",
      strokeThickness: 2
    });
    for (let fx = HOME_FIELD_CENTER.x - 158; fx <= HOME_FIELD_CENTER.x + 158; fx += 20) {
      this.add.rectangle(fx, HOME_FIELD_CENTER.y + 145, 4, 14, 0x8b6b44, 0.9).setDepth(4);
      this.add.rectangle(fx, HOME_FIELD_CENTER.y - 145, 4, 14, 0x8b6b44, 0.9).setDepth(4);
    }
    for (let fy = HOME_FIELD_CENTER.y - 145; fy <= HOME_FIELD_CENTER.y + 145; fy += 20) {
      this.add.rectangle(HOME_FIELD_CENTER.x - 170, fy, 4, 14, 0x8b6b44, 0.9).setDepth(4);
      this.add.rectangle(HOME_FIELD_CENTER.x + 170, fy, 4, 14, 0x8b6b44, 0.9).setDepth(4);
    }
    this.add.rectangle(HOME_FIELD_CENTER.x, HOME_FIELD_CENTER.y + 145, 52, 4, 0x8b6b44, 0.95).setDepth(4);
    this.add.rectangle(HOME_FIELD_CENTER.x, HOME_FIELD_CENTER.y - 145, 52, 4, 0x8b6b44, 0.95).setDepth(4);
    this.add.rectangle(HOME_FIELD_CENTER.x + 120, HOME_FIELD_CENTER.y + 105, 44, 36, 0x7b5b37, 0.95).setDepth(5);
    this.add.rectangle(HOME_FIELD_CENTER.x + 120, HOME_FIELD_CENTER.y + 86, 48, 8, 0x5f4330, 0.96).setDepth(5);

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
    const cropSelect = document.getElementById("farm-crop");
    const sowBtn = document.getElementById("farm-sow");
    const waterBtn = document.getElementById("farm-water");
    const harvestBtn = document.getElementById("farm-harvest");
    const farmUnselect = document.getElementById("farm-unselect");
    cropSelect.addEventListener("change", () => this.updateFarmHud());
    sowBtn?.addEventListener("click", () => this.sendFarmAction("sow"));
    waterBtn?.addEventListener("click", () => this.sendFarmAction("water"));
    harvestBtn?.addEventListener("click", () => this.sendFarmAction("harvest"));
    farmUnselect?.addEventListener("click", () => this.clearSelectedPlot());
    this.input.keyboard.on("keydown-ONE", () => this.sendFarmAction("sow"));
    this.input.keyboard.on("keydown-TWO", () => this.sendFarmAction("water"));
    this.input.keyboard.on("keydown-THREE", () => this.sendFarmAction("harvest"));
    this.input.keyboard.on("keydown-Q", () => this.shiftFarmCrop(-1));
    this.input.keyboard.on("keydown-E", () => this.shiftFarmCrop(1));
  }

  createFarmToolbelt() {
    const panel = this.add.container(0, 0).setDepth(130).setScrollFactor(0);
    const bg = this.add.rectangle(0, 0, 220, 56, 0x12100d, 0.84).setStrokeStyle(1, 0xd0bd8b, 0.9);
    const title = this.add.text(-98, -23, "Farm Tools", {
      fontSize: "11px",
      color: "#f1e4b2"
    });
    panel.add([bg, title]);

    const makeToolButton = (x, key, action, hotkey) => {
      const hit = this.add.circle(x, 5, 13, 0x000000, 0).setStrokeStyle(1, 0xc9ba90, 0.95);
      const icon = this.add.image(x, 5, key).setScale(1.2);
      const label = this.add.text(x - 18, 19, hotkey, { fontSize: "9px", color: "#dfd2a3" });
      hit.setInteractive({ useHandCursor: true });
      hit.on("pointerdown", () => this.sendFarmAction(action));
      panel.add([hit, icon, label]);
      return { action, hit, icon, label };
    };

    this.farmToolButtons = [
      makeToolButton(-62, "tool_sow", "sow", "1"),
      makeToolButton(0, "tool_water", "water", "2"),
      makeToolButton(62, "tool_harvest", "harvest", "3")
    ];
    this.farmToolbelt = panel;
    this.positionFarmToolbelt();
    this.updateFarmToolbeltState();
    this.scale.on("resize", () => this.positionFarmToolbelt());
  }

  positionFarmToolbelt() {
    if (!this.farmToolbelt) return;
    const cam = this.cameras.main;
    this.farmToolbelt.setPosition(cam.width * 0.5, cam.height - 44);
  }

  shiftFarmCrop(direction = 1) {
    const cropSelect = document.getElementById("farm-crop");
    if (!cropSelect || !cropSelect.options?.length) return;
    const len = cropSelect.options.length;
    const next = (cropSelect.selectedIndex + direction + len) % len;
    cropSelect.selectedIndex = next;
    this.updateFarmHud();
  }

  sendFarmAction(action) {
    if (!this.socket?.connected || !this.selectedPlotId || this.isDialogueHardLocked || !this.isNearFarm) return;
    const cropSelect = document.getElementById("farm-crop");
    this.socket.emit("farm_action", {
      action,
      plotId: this.selectedPlotId,
      cropType: cropSelect?.value || "turnip"
    });
  }

  clearSelectedPlot() {
    this.selectedPlotId = null;
    this.setFarmPanelVisible(false);
    this.updateFarmHud();
    this.updateFarmToolbeltState();
    this.syncFarmPlots();
  }

  clearSelectedPerson() {
    if (this.isDialogueHardLocked) return;
    this.activeDialogueNpcId = null;
    this.activeDialogueNpcName = "";
    this.updateChatTarget();
    for (const sprite of this.npcSprites.values()) {
      sprite.body.setTint(sprite.tint);
      sprite.body.setScale(1);
    }
  }

  isPlayerNearFarm() {
    if (!this.farmData?.plots?.length) return false;
    let nearest = Number.POSITIVE_INFINITY;
    for (const plot of this.farmData.plots) {
      const dist = Math.hypot((plot.x || 0) - this.player.x, (plot.y || 0) - this.player.y);
      if (dist < nearest) nearest = dist;
    }
    return nearest <= FARM_TOOL_DISTANCE;
  }

  updateFarmToolbeltState() {
    this.isNearFarm = this.isPlayerNearFarm();
    if (this.farmToolbelt) {
      this.farmToolbelt.setVisible(this.farmPanelVisible && this.isNearFarm);
    }
    const hintEl = document.getElementById("farm-hint");
    if (hintEl) {
      hintEl.textContent = this.isNearFarm
        ? "Select a plot, then use tools or keys 1/2/3. Change crop with Q/E."
        : "Move near your home field to access farming tools.";
    }
    const selected = this.selectedPlot();
    const enabled = this.isNearFarm && Boolean(selected) && !this.isDialogueHardLocked && !this.isSleeping;
    for (const btn of this.farmToolButtons) {
      btn.hit.setAlpha(enabled ? 1 : 0.4);
      btn.icon.setAlpha(enabled ? 1 : 0.45);
      btn.label.setAlpha(enabled ? 1 : 0.45);
    }
  }

  setFarmPanelVisible(visible) {
    this.farmPanelVisible = Boolean(visible);
    const panel = document.getElementById("farm-panel");
    if (!panel) return;
    panel.classList.toggle("hidden", !this.farmPanelVisible);
    this.updateFarmToolbeltState();
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
    this.input.keyboard.on("keydown-ESC", () => {
      this.clearSelectedPlot();
      this.clearSelectedPerson();
    });
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
    const econ = world.economy;
    if (econ?.cropPrices) {
      const t = econ.cropPrices.turnip ?? "-";
      const c = econ.cropPrices.carrot ?? "-";
      const p = econ.cropPrices.pumpkin ?? "-";
      document.getElementById("economy").textContent = `Market ${econ.mood || "steady"}: T${t} C${c} P${p}`;
    } else {
      document.getElementById("economy").textContent = "Market: ...";
    }
    const events = Array.isArray(world.worldEvents?.active) ? world.worldEvents.active : [];
    const eventsText =
      events.length > 0
        ? `Events: ${events
            .slice(0, 2)
            .map((evt) => `${evt.title}${evt.area ? ` (${evt.area})` : ""}`)
            .join(" | ")}`
        : "Events: none";
    document.getElementById("world-events").textContent = eventsText;
    const tensions = Array.isArray(world.factions?.tensions) ? world.factions.tensions : [];
    const factionText =
      tensions.length > 0
        ? `Factions: ${tensions
            .slice(0, 1)
            .map((t) => `${t.a} vs ${t.b} (${t.level})`)
            .join("")}`
        : `Factions: ${Array.isArray(world.factions?.groups) ? world.factions.groups.length : 0} groups`;
    document.getElementById("factions").textContent = factionText;
    const missionLabel = world.mission?.completed
      ? "Mission: All complete"
      : `Mission ${world.mission?.step || 1}/${world.mission?.total || 1}: ${world.mission?.title || "Explore town"}`;
    const missionProgress = world.mission?.progress ? ` (${world.mission.progress})` : "";
    const missionReward = Number.isFinite(Number(world.mission?.rewardCoins)) ? ` | +${world.mission.rewardCoins}c` : "";
    const urgencyText = Number(world.mission?.urgency) >= 3 ? " [Urgent]" : Number(world.mission?.urgency) === 2 ? " [Active]" : "";
    document.getElementById("mission").textContent = `${missionLabel}${missionProgress}${missionReward}${urgencyText}`;
    const townMission = world.townMission;
    const townMissionText = townMission
      ? `Town Gossip Mission: ${townMission.title} (${townMission.progress})`
      : "Town Gossip Mission: waiting...";
    document.getElementById("town-mission").textContent = townMissionText;
    const storyArc = world.storyArc;
    const storyArcText = storyArc
      ? storyArc.completed
        ? `Story Arc: ${storyArc.title} (resolved)`
        : `Story Arc ${storyArc.stageIndex || 1}/${storyArc.stageTotal || 1}: ${storyArc.currentStage || storyArc.title} (${storyArc.progress || "0/1"})`
      : "Story Arc: waiting...";
    document.getElementById("story-arc").textContent = storyArcText;
    this.applyDayNightVisuals(world);

    if (world.you?.name) {
      this.playerProfile.name = world.you.name;
      this.playerProfile.gender = world.you.gender || "unspecified";
      this.playerLabel.setText(world.you.name);
      const repLabel = world.you?.reputation?.label ? `, rep: ${world.you.reputation.label}` : "";
      document.getElementById("player-profile").textContent =
        `Player: ${world.you.name} (${this.playerProfile.gender}${repLabel})`;
    }

    if (world.you) {
      this.player.x = world.you.x;
      this.player.y = world.you.y;
    }

    this.farmData = world.farm || null;
    this.syncFarmPlots();
    this.updateFarmHud();
    this.updateFarmToolbeltState();

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

  syncFarmPlots() {
    const liveIds = new Set();
    for (const plot of this.farmData?.plots || []) {
      liveIds.add(plot.id);
      let sprite = this.farmPlotSprites.get(plot.id);

      if (!sprite) {
        const bed = this.add.graphics().setDepth(8);
        const crop = this.add.graphics().setDepth(9);
        const moisture = this.add.rectangle(plot.x, plot.y + 15, 0, 3, 0x4fa4cb, 0.95).setDepth(10);
        const selection = this.add.rectangle(plot.x, plot.y, 38, 38, 0x000000, 0).setDepth(11);
        selection.setStrokeStyle(1, 0x2c2117, 0.95);
        selection.setInteractive({ useHandCursor: true });
        const label = this.add.text(plot.x - 16, plot.y - 8, `#${plot.id}`, {
          fontSize: "9px",
          color: "#f6edd0",
          stroke: "#111",
          strokeThickness: 2
        });
        label.setDepth(10);

        selection.on("pointerdown", () => {
          this.selectedPlotId = this.selectedPlotId === plot.id ? null : plot.id;
          this.setFarmPanelVisible(Boolean(this.selectedPlotId));
          this.updateFarmHud();
          this.updateFarmToolbeltState();
          this.syncFarmPlots();
        });

        sprite = { bed, crop, moisture, selection, label };
        this.farmPlotSprites.set(plot.id, sprite);
      }

      const selected = this.selectedPlotId === plot.id;
      const baseByState = {
        empty: 0x7c5e39,
        seeded: 0x6f5433,
        growing: 0x5f482b,
        ready: 0x72502d
      };
      const accentByState = {
        empty: 0x9b7a4d,
        seeded: 0x8d6c43,
        growing: 0x8f6a3c,
        ready: 0xae8d4d
      };
      const base = baseByState[plot.state] || 0x7c5e39;
      const accent = accentByState[plot.state] || 0x9b7a4d;

      sprite.bed.clear();
      sprite.bed.fillStyle(0x20160f, 0.28);
      sprite.bed.fillRoundedRect(plot.x - 16, plot.y - 14, 32, 30, 4);
      sprite.bed.fillStyle(base, 0.98);
      sprite.bed.fillRoundedRect(plot.x - 15, plot.y - 15, 30, 28, 4);
      sprite.bed.fillStyle(accent, 0.88);
      for (let i = 0; i < 3; i += 1) {
        sprite.bed.fillRect(plot.x - 12, plot.y - 10 + i * 8, 24, 2);
      }

      const waterPct = clamp01((plot.water || 0) / 100);
      sprite.moisture.setPosition(plot.x, plot.y + 15);
      sprite.moisture.width = Math.max(2, Math.round(28 * waterPct));
      sprite.moisture.setFillStyle(waterPct > 0.65 ? 0x66b8d8 : waterPct > 0.25 ? 0x4d99be : 0x35647f, 0.95);

      sprite.crop.clear();
      const maxGrowth = CROP_GROW_MINUTES[plot.cropType] || 360;
      const growthPct = clamp01((plot.growth || 0) / maxGrowth);
      if (plot.state === "seeded") {
        sprite.crop.fillStyle(0xcbb28a, 0.95);
        sprite.crop.fillCircle(plot.x - 5, plot.y - 2, 1.7);
        sprite.crop.fillCircle(plot.x + 1, plot.y + 1, 1.7);
        sprite.crop.fillCircle(plot.x + 6, plot.y - 1, 1.7);
      } else if (plot.state === "growing") {
        const stemHeight = 4 + Math.round(growthPct * 8);
        sprite.crop.lineStyle(2, 0x4e8e48, 1);
        sprite.crop.lineBetween(plot.x - 4, plot.y + 5, plot.x - 4, plot.y + 5 - stemHeight);
        sprite.crop.lineBetween(plot.x + 2, plot.y + 6, plot.x + 2, plot.y + 6 - stemHeight - 2);
        sprite.crop.fillStyle(0x79bf68, 0.95);
        sprite.crop.fillCircle(plot.x - 5, plot.y + 2 - stemHeight, 2.3);
        sprite.crop.fillCircle(plot.x + 3, plot.y + 1 - stemHeight, 2.3);
      } else if (plot.state === "ready") {
        sprite.crop.fillStyle(0x4f8a3e, 1);
        sprite.crop.fillCircle(plot.x - 5, plot.y + 1, 3.4);
        sprite.crop.fillCircle(plot.x + 3, plot.y - 1, 3.4);
        sprite.crop.fillStyle(0xf2cb5d, 0.96);
        sprite.crop.fillCircle(plot.x - 4, plot.y - 3, 2.4);
        sprite.crop.fillCircle(plot.x + 4, plot.y - 5, 2.4);
      }

      sprite.selection.setPosition(plot.x, plot.y);
      sprite.selection.setStrokeStyle(selected ? 2 : 1, selected ? 0xf6e27f : 0x2c2117, 0.95);
      sprite.label.setText(`#${plot.id}`);
      sprite.label.setPosition(plot.x - 16, plot.y - 8);
    }

    for (const [plotId, sprite] of this.farmPlotSprites.entries()) {
      if (liveIds.has(plotId)) continue;
      sprite.bed.destroy();
      sprite.crop.destroy();
      sprite.moisture.destroy();
      sprite.selection.destroy();
      sprite.label.destroy();
      this.farmPlotSprites.delete(plotId);
    }

    if (this.selectedPlotId && !liveIds.has(this.selectedPlotId)) {
      this.selectedPlotId = null;
      this.setFarmPanelVisible(false);
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
    const cropEl = document.getElementById("farm-crop");

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
    const selectedCrop = cropEl?.value || "turnip";
    const seeds = Number(i[`${selectedCrop}_seed`] || 0);
    invEl.textContent =
      `Inventory: turnip ${i.turnip || 0}, carrot ${i.carrot || 0}, pumpkin ${i.pumpkin || 0}` +
      ` | seeds T:${i.turnip_seed || 0} C:${i.carrot_seed || 0} P:${i.pumpkin_seed || 0} | selected ${selectedCrop} seeds ${seeds}`;
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
    this.updateFarmToolbeltState();
    this.positionFarmToolbelt();

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
