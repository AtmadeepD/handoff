# Changelog

## 2026-10-25 — M1: Lobby and deploy-ready service
- Created a single Node.js + TypeScript + Socket.IO service that serves the built client and WebSocket from one origin.
- Added nickname-only room creation/join, 4-letter codes excluding I/O/L, host-controlled shift/difficulty, QR invite link, six seats, refresh reconnect token, in-memory rooms, and 30-minute idle expiry.
- Added `/health` and `/api/status` endpoints.
- Added Vitest two-client room integration test. No gameplay simulation or later milestones included.
- All interface artwork is drawn with Canvas/CSS; QR is generated locally in code. Shift 1 duration remains sourced from `HANDOFF_DATA.ts` (180 seconds).
