export const WORLD_WIDTH = 1600;
export const WORLD_HEIGHT = 1200;
export const TILE_SIZE = 32;

export const AREAS = [
  { name: "Town Square", x: 560, y: 460, w: 480, h: 280 },
  { name: "Market Street", x: 220, y: 240, w: 280, h: 420 },
  { name: "Dock", x: 1180, y: 760, w: 340, h: 300 },
  { name: "Sanctum", x: 1060, y: 160, w: 280, h: 220 },
  { name: "Forest", x: 120, y: 760, w: 360, h: 320 },
  { name: "Housing", x: 520, y: 120, w: 420, h: 240 }
];

export const NPC_SEEDS = [
  {
    id: "npc_businessman",
    name: "Alden",
    role: "Businessman",
    traits: ["greedy", "charming", "calculating"],
    x: 320,
    y: 350,
    area: "Market Street"
  },
  {
    id: "npc_politician",
    name: "Maris",
    role: "Politician",
    traits: ["ambitious", "eloquent", "paranoid"],
    x: 700,
    y: 510,
    area: "Town Square"
  },
  {
    id: "npc_fisherman",
    name: "Bram",
    role: "Fisherman",
    traits: ["practical", "superstitious", "kind"],
    x: 1310,
    y: 910,
    area: "Dock"
  },
  {
    id: "npc_shop_owner",
    name: "Tessa",
    role: "Shop Owner",
    traits: ["funny", "frugal", "observant"],
    x: 370,
    y: 500,
    area: "Market Street"
  },
  {
    id: "npc_artist",
    name: "Ivo",
    role: "Artist",
    traits: ["dramatic", "sensitive", "curious"],
    x: 650,
    y: 240,
    area: "Housing"
  },
  {
    id: "npc_devotee",
    name: "Sister Elen",
    role: "Religious Devotee",
    traits: ["calm", "moral", "strict"],
    x: 1170,
    y: 240,
    area: "Sanctum"
  },
  {
    id: "npc_cultist",
    name: "Crow",
    role: "Cultist",
    traits: ["cryptic", "intense", "secretive"],
    x: 260,
    y: 980,
    area: "Forest"
  },
  {
    id: "npc_guard",
    name: "Rook",
    role: "Town Guard",
    traits: ["stern", "loyal", "vigilant"],
    x: 840,
    y: 560,
    area: "Town Square"
  },
  {
    id: "npc_herbalist",
    name: "Mira",
    role: "Herbalist",
    traits: ["gentle", "wise", "cautious"],
    x: 210,
    y: 860,
    area: "Forest"
  },
  {
    id: "npc_blacksmith",
    name: "Doran",
    role: "Blacksmith",
    traits: ["gruff", "honest", "hardworking"],
    x: 560,
    y: 300,
    area: "Housing"
  }
];
