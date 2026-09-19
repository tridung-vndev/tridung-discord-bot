# TriDung Discord Bot v15 — Render Stable

## Render
- Runtime: Node.js
- Build: `npm install`
- Start: `npm run start`
- Environment: `DISCORD_TOKEN`, `OWNER_ID`
- Optional: `DATA_DIR`, `MAIN_GUILD_ID`, `MAIN_CHANNEL_ID`

## Health
Render can use `/health` or `/healthz` for the HTTP health endpoint. The root path also returns a simple status.

## Database
Uses local `data/db.json`. Writes are atomic and keep `db.json.bak`. **Render's free filesystem is not guaranteed to survive a redeploy/rebuild**, so use a persistent database/disk if permanent economy data is required.

## Important
The bot does not self-ping Render or bypass Render sleep/usage limits.
