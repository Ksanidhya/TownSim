create table if not exists public.players (
  id text primary key,
  username text not null unique,
  gender text not null default 'unspecified',
  password_salt text not null,
  password_hash text not null,
  created_at timestamptz not null default now(),
  last_login_at timestamptz
);

create table if not exists public.memories (
  id bigserial primary key,
  npc_id text not null,
  memory_type text not null,
  content text not null,
  importance integer not null default 3,
  tags text not null default '',
  created_at timestamptz not null default now()
);

create index if not exists idx_memories_npc_id_id on public.memories (npc_id, id desc);

create table if not exists public.relationships (
  npc_id text not null,
  player_id text not null,
  score integer not null default 0,
  last_interaction_at timestamptz,
  primary key (npc_id, player_id)
);
