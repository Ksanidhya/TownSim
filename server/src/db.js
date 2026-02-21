import { Pool } from "pg";

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

  const pool = new Pool({
    connectionString,
    ssl: buildSslConfig(connectionString)
  });

  return pool;
}

export async function ensureSchema(db) {
  await db.query(`
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
