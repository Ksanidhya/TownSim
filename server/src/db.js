import { Pool } from "pg";
import dns from "node:dns";

function buildSslConfig(connectionString) {
  const forceSsl = process.env.PG_SSL === "true";
  const disableSsl = process.env.PG_SSL === "false";
  const supabaseHost = connectionString?.includes(".supabase.co");

  if (disableSsl) return false;
  if (forceSsl || supabaseHost) {
    return { rejectUnauthorized: false };
  }
  return false;
}

export function initDb() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is required. Set it in server/.env.");
  }

  // Prefer IPv4 when both A and AAAA records are present to avoid ENETUNREACH
  // on platforms without outbound IPv6 routing.
  dns.setDefaultResultOrder("ipv4first");

  const renderDetected =
    String(process.env.RENDER || "").toLowerCase() === "true" ||
    Boolean(process.env.RENDER_SERVICE_ID) ||
    Boolean(process.env.RENDER_INSTANCE_ID);
  const forceIpv4 =
    process.env.PG_FORCE_IPV4 === "true" || (process.env.PG_FORCE_IPV4 !== "false" && renderDetected);

  const pool = new Pool({
    connectionString,
    ssl: buildSslConfig(connectionString),
    ...(forceIpv4 ? { family: 4 } : {})
  });

  return pool;
}

export async function ensureSchema(db) {
  await db.query(`
    CREATE TABLE IF NOT EXISTS players (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      gender TEXT NOT NULL DEFAULT 'unspecified',
      password_salt TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_login_at TIMESTAMPTZ
    );

    CREATE TABLE IF NOT EXISTS memories (
      id BIGSERIAL PRIMARY KEY,
      npc_id TEXT NOT NULL,
      memory_type TEXT NOT NULL,
      content TEXT NOT NULL,
      importance INTEGER NOT NULL DEFAULT 3,
      tags TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_memories_npc_id_id ON memories (npc_id, id DESC);

    CREATE TABLE IF NOT EXISTS relationships (
      npc_id TEXT NOT NULL,
      player_id TEXT NOT NULL,
      score INTEGER NOT NULL DEFAULT 0,
      last_interaction_at TIMESTAMPTZ,
      PRIMARY KEY (npc_id, player_id)
    );
  `);
}

export async function createPlayerAccount(db, account) {
  const result = await db.query(
    `
      INSERT INTO players (id, username, gender, password_salt, password_hash, last_login_at)
      VALUES ($1, $2, $3, $4, $5, NOW())
      RETURNING id, username, gender
    `,
    [account.id, account.username, account.gender, account.passwordSalt, account.passwordHash]
  );
  return result.rows[0];
}

export async function getPlayerByUsername(db, username) {
  const result = await db.query(
    `
      SELECT id, username, gender, password_salt, password_hash
      FROM players
      WHERE username = $1
      LIMIT 1
    `,
    [username]
  );
  return result.rows[0] || null;
}

export async function touchPlayerLogin(db, id) {
  await db.query(
    `
      UPDATE players
      SET last_login_at = NOW()
      WHERE id = $1
    `,
    [id]
  );
}

export async function writeMemory(db, memory) {
  await db.query(
    `
      INSERT INTO memories (npc_id, memory_type, content, importance, tags, created_at)
      VALUES ($1, $2, $3, $4, $5, $6)
    `,
    [memory.npcId, memory.type, memory.content, memory.importance, memory.tags, memory.createdAt]
  );
}

export async function getRecentMemories(db, npcId, limit = 6) {
  const result = await db.query(
    `
      SELECT npc_id, memory_type, content, importance, tags, created_at
      FROM memories
      WHERE npc_id = $1
      ORDER BY id DESC
      LIMIT $2
    `,
    [npcId, limit]
  );
  return result.rows;
}

export async function getRecentMemoriesByTag(db, npcId, tagLike, limit = 6) {
  const tag = String(tagLike || "").trim();
  if (!tag) return [];
  const result = await db.query(
    `
      SELECT npc_id, memory_type, content, importance, tags, created_at
      FROM memories
      WHERE npc_id = $1
        AND tags LIKE $2
      ORDER BY id DESC
      LIMIT $3
    `,
    [npcId, `%${tag}%`, limit]
  );
  return result.rows;
}

export async function upsertRelationshipDelta(db, npcId, playerId, delta) {
  await db.query(
    `
      INSERT INTO relationships (npc_id, player_id, score, last_interaction_at)
      VALUES ($1, $2, $3, NOW())
      ON CONFLICT (npc_id, player_id)
      DO UPDATE SET
        score = relationships.score + EXCLUDED.score,
        last_interaction_at = EXCLUDED.last_interaction_at
    `,
    [npcId, playerId, delta]
  );
}

export async function hasNpcIntroducedToPlayer(db, npcId, playerId) {
  const result = await db.query(
    `
      SELECT 1
      FROM memories
      WHERE npc_id = $1
        AND memory_type = 'player_intro'
        AND tags LIKE $2
      LIMIT 1
    `,
    [npcId, `%${playerId}%`]
  );
  return result.rowCount > 0;
}
