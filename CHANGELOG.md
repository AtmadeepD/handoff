# Changelog

## 2026-10-25 — M1: Lobby and deploy-ready service
- Created a single Node.js + TypeScript + Socket.IO service that serves the built client and WebSocket from one origin.
- Added nickname-only room creation/join, 4-letter codes excluding I/O/L, host-controlled shift/difficulty, QR invite link, six seats, refresh reconnect token, in-memory rooms, and 30-minute idle expiry.
- Added `/health` and `/api/status` endpoints.
- Added Vitest two-client room integration test. No gameplay simulation or later milestones included.
- All interface artwork is drawn with Canvas/CSS; QR is generated locally in code. Shift 1 duration remains sourced from `HANDOFF_DATA.ts` (180 seconds).

## 2026-10-25 — M1 build fix
- Build: split TypeScript config (server = NodeNext, client = bundler); Render build no longer fails.
- Pinned Node 22.x (Render was picking Node 26).
- Fixed SPA fallback path (was dist/dist/public/index.html).
- Reconnect tokens are now random secrets, not the public player id.
- Host keeps host controls after a refresh (compare stable player id, not socket id).
- QR code is dark-on-light so phone cameras can scan it.
- Removed empty CSS @import.
- Tests actually run now (dedicated vitest.config.ts); added reconnect and bad-code tests. 3/3 pass.


## 2026-10-25 — M2: Core single-sector simulation (verified)
ChatGPT's M2 draft built but did not play. Reviewed and rewritten by Claude on top of it:
- Snapshots were never sent (15/20 Hz counter could not reach its threshold). Now exactly 15/s; tested.
- Planes without a path froze at the rim. Now they fly straight and turn back at the rim.
- Landing was impossible (a path drawn onto the airport hit a divide-by-zero guard). Now: a path ending in the
  destination's approach cone is finished onto the runway and lands on touchdown; wrong airports never land.
- Fuel-out planes became invisible ghosts that blocked new spawns. Now removed, strike counted, effect shown.
- Pressing Start bounced everyone back to the lobby. Screen is now routed by the server's room phase.
- Score/timer never updated; planes were picked from a list. Now a full-screen radar with live HUD and
  drag-from-the-plane path drawing, interpolated rendering (100 ms buffer), pending/confirmed/rejected paths.
- Refresh mid-shift restores the live game. End-of-shift card with Play again / Back to lobby (host).
- Seeded spawning (mulberry32), unique callsigns, spawns keep clear of other planes.
- URL parameters are preserved when joining (needed for ?debug=1 and ?spectate= later).
- Tests: 17 passing (engine rules, ~15 Hz shared snapshots on two clients, path broadcast, mid-shift reconnect).
- Known for M3: the whole sky is shown and everyone can steer every plane; sectors and handoffs come next.
