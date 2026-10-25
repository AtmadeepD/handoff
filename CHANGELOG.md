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

