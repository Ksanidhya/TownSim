# Town Sim MVP (Phaser + Node + OpenAI)

Stardew-inspired top-down pixel town prototype with:

- free player movement
- home farm gameplay (sowing, watering, harvesting)
- account-based profiles (create game / load game with password)
- autonomous NPC movement
- NPC-to-NPC and NPC-to-player proximity conversations
- OpenAI-backed dialogue (with offline fallback lines)
- persistent NPC memory + relationship deltas in Supabase Postgres

## Stack

- Client: `Phaser 3` + `Vite` + `socket.io-client`
- Server: `Node.js` + `Express` + `Socket.IO` + `pg` + `openai`

## Supabase Setup

1. Create a Supabase project.
2. In Supabase dashboard, open `SQL Editor` and run `server/supabase/schema.sql`.
3. In Supabase dashboard, open `Project Settings -> Database`.
4. Copy the connection string and replace `[YOUR-PASSWORD]` with your DB password.
5. Put it in `server/.env` as `DATABASE_URL`.

## Run

1. Install deps:
```powershell
npm install
npm --prefix server install
npm --prefix client install
```

2. Configure env:
```powershell
Copy-Item server/.env.example server/.env
Copy-Item client/.env.example client/.env
```

3. Add your OpenAI key in `server/.env`:
```env
OPENAI_API_KEY=your_key_here
DATABASE_URL=postgresql://postgres:[YOUR-PASSWORD]@db.[PROJECT-REF].supabase.co:5432/postgres
PG_SSL=true
PG_FORCE_IPV4=true
```

`PG_FORCE_IPV4=true` is recommended on Render when Postgres hostname resolution returns IPv6 and deploy logs show `ENETUNREACH`.

4. Start both:
```powershell
npm run dev
```

5. Open client:
- `http://localhost:5173`

## Controls

- Move: `Arrow keys`
- NPCs talk automatically on proximity
- At launch, choose `Create New Game` (username + password + gender) or `Load Game` (username + password)
- Farming: go to your home field in Housing, click a plot, then use `Sow`, `Water`, `Harvest` in HUD

## Notes

- If no `OPENAI_API_KEY` is set, NPCs use role-based fallback dialogue.
- Player identity is persisted in browser local storage and sent to server.
- NPC memory and relationships are stored in Supabase Postgres.

## Next Up

- Tilemap import from Tiled (`.json`)
- Building collision layers and proper house/shop sprites
- Schedule system (day/night jobs + curfew)
- Multi-NPC turn-based conversation manager
- Memory retrieval ranking (importance + recency + tag match)
