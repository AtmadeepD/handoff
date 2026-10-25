import express from 'express';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { Server, Socket } from 'socket.io';
import { AIRPORT_STYLES } from './shared/HANDOFF_DATA.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: true, credentials: false }, pingInterval: 25000, pingTimeout: 20000 });
const PORT = Number(process.env.PORT || 3000);
const ROOM_IDLE_MS = 30 * 60 * 1000;
const MAX_PLAYERS = 6;
const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ'; // excludes I, O and L

type Player = { id: string; nickname: string; seat: number; color: string; connected: boolean; joinedAt: number };
type Room = { code: string; hostId: string; players: Map<string, Player>; createdAt: number; lastActiveAt: number; settings: { shift: number; difficulty: 'cadet'|'controller'|'chief' }; reconnectTokens: Map<string, string> };
const rooms = new Map<string, Room>();
const socketPlayers = new Map<string, { code: string; playerId: string }>();

function newToken(): string { return randomBytes(18).toString('base64url'); }
function codeCandidate(): string {
  let code = '';
  for (let i = 0; i < 4; i++) code += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  return code;
}
function createCode(): string {
  for (let attempt = 0; attempt < 10000; attempt++) { const code = codeCandidate(); if (!rooms.has(code)) return code; }
  throw new Error('Could not allocate a unique room code');
}
function cleanNickname(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const name = value.trim().replace(/\s+/g, ' ').slice(0, 18);
  return name.length >= 1 ? name : null;
}
function publicRoom(room: Room) {
  return { code: room.code, hostId: room.hostId, players: [...room.players.values()].map(p => ({ id: p.id, nickname: p.nickname, seat: p.seat, color: p.color, connected: p.connected })), settings: room.settings, maxPlayers: MAX_PLAYERS };
}
function broadcast(room: Room) { io.to(room.code).emit('lobby_state', publicRoom(room)); }
function fail(socket: Socket, message: string) { socket.emit('room_error', { message }); }
function bindPlayer(socket: Socket, room: Room, player: Player) {
  socketPlayers.set(socket.id, { code: room.code, playerId: player.id });
  socket.join(room.code);
  player.connected = true;
  room.lastActiveAt = Date.now();
}
function detachSocket(socket: Socket) {
  const bound = socketPlayers.get(socket.id);
  if (!bound) return;
  socketPlayers.delete(socket.id);
  const room = rooms.get(bound.code);
  const player = room?.players.get(bound.playerId);
  if (room && player) { player.connected = false; room.lastActiveAt = Date.now(); broadcast(room); }
}

app.disable('x-powered-by');
app.get('/health', (_req, res) => res.status(200).json({ ok: true, service: 'handoff', rooms: rooms.size, uptimeSeconds: Math.floor(process.uptime()) }));
app.get('/api/status', (_req, res) => res.json({ ok: true, rooms: rooms.size, maxPlayers: MAX_PLAYERS }));
app.use(express.static(path.join(__dirname, '../public')));
app.get('*', (_req, res) => res.sendFile(path.join(__dirname, '../public/index.html')));

io.on('connection', socket => {
  socket.on('create_room', (payload: { nickname?: unknown } = {}) => {
    const nickname = cleanNickname(payload.nickname);
    if (!nickname) return fail(socket, 'Enter a nickname (1–18 characters).');
    const code = createCode();
    const playerId = socket.id;
    const player: Player = { id: playerId, nickname, seat: 0, color: AIRPORT_STYLES[0].color, connected: true, joinedAt: Date.now() };
    const room: Room = { code, hostId: playerId, players: new Map([[playerId, player]]), createdAt: Date.now(), lastActiveAt: Date.now(), settings: { shift: 1, difficulty: 'controller' }, reconnectTokens: new Map() };
    const reconnectToken = newToken();
    room.reconnectTokens.set(reconnectToken, playerId); rooms.set(code, room); bindPlayer(socket, room, player);
    socket.emit('room_created', { room: publicRoom(room), reconnectToken, playerId }); broadcast(room);
  });

  socket.on('join_room', (payload: { code?: unknown; nickname?: unknown; reconnectToken?: unknown } = {}) => {
    const code = typeof payload.code === 'string' ? payload.code.trim().toUpperCase() : '';
    const room = rooms.get(code);
    if (!room) return fail(socket, 'Room not found. Check the 4-letter code.');
    const token = typeof payload.reconnectToken === 'string' ? payload.reconnectToken : '';
    if (token && room.reconnectTokens.has(token)) {
      const playerId = room.reconnectTokens.get(token)!;
      const player = room.players.get(playerId);
      if (player) {
        for (const [sid, bound] of socketPlayers) if (bound.code === code && bound.playerId === playerId) io.sockets.sockets.get(sid)?.disconnect(true);
        player.connected = true; bindPlayer(socket, room, player); socket.emit('room_joined', { room: publicRoom(room), reconnectToken: token, playerId }); broadcast(room); return;
      }
    }
    const nickname = cleanNickname(payload.nickname);
    if (!nickname) return fail(socket, 'Enter a nickname (1–18 characters).');
    if (room.players.size >= MAX_PLAYERS) return fail(socket, 'This room is full (6 controllers maximum).');
    const seat = [...room.players.values()].reduce((max, p) => Math.max(max, p.seat), -1) + 1;
    const playerId = socket.id;
    const reconnectToken = newToken();
    const player: Player = { id: playerId, nickname, seat, color: AIRPORT_STYLES[seat % AIRPORT_STYLES.length].color, connected: true, joinedAt: Date.now() };
    room.players.set(playerId, player); room.reconnectTokens.set(reconnectToken, playerId); bindPlayer(socket, room, player);
    socket.emit('room_joined', { room: publicRoom(room), reconnectToken, playerId }); broadcast(room);
  });

  socket.on('set_settings', (payload: { shift?: unknown; difficulty?: unknown } = {}) => {
    const bound = socketPlayers.get(socket.id); const room = bound && rooms.get(bound.code);
    if (!room || room.hostId !== bound?.playerId) return fail(socket, 'Only the room host can change settings.');
    if (Number.isInteger(payload.shift) && Number(payload.shift) >= 1 && Number(payload.shift) <= 8) room.settings.shift = Number(payload.shift);
    if (payload.difficulty === 'cadet' || payload.difficulty === 'controller' || payload.difficulty === 'chief') room.settings.difficulty = payload.difficulty;
    room.lastActiveAt = Date.now(); broadcast(room);
  });
  socket.on('ping_room', () => { const b = socketPlayers.get(socket.id); const r = b && rooms.get(b.code); if (r) r.lastActiveAt = Date.now(); socket.emit('pong_room', { at: Date.now() }); });
  socket.on('leave_room', () => { detachSocket(socket); socket.leave([...socket.rooms].find(r => r !== socket.id) || ''); });
  socket.on('disconnect', () => detachSocket(socket));
});

const expiry = setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) if (now - room.lastActiveAt >= ROOM_IDLE_MS) { io.to(code).emit('room_closed', { message: 'This room expired after 30 minutes idle.' }); rooms.delete(code); }
}, 60_000);
expiry.unref();

if (process.env.NODE_ENV !== 'test') server.listen(PORT, '0.0.0.0', () => console.log(`HANDOFF listening on ${PORT}`));
export { app, server, io, rooms, ROOM_IDLE_MS, createCode, cleanNickname };
