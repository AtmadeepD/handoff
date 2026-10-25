import express from 'express';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { Server, Socket } from 'socket.io';
import {
  AIRCRAFT, AIRPORT_STYLES, CALLSIGN_PREFIXES, DIFFICULTY, PLAYER_SCALING, SHIFTS,
  SIM_TICKS_PER_SECOND, SNAPSHOTS_PER_SECOND, spawnInterval, type AircraftType, type Difficulty, type Shift,
} from './shared/HANDOFF_DATA.js';
import {
  findSpawn, makeAirports, mulberry32, pickWeighted, preparePath, stepPlane,
  type Airport, type Plane, type Rng,
} from './shared/engine.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: true, credentials: false }, pingInterval: 25000, pingTimeout: 20000 });
const PORT = Number(process.env.PORT || 3000);
const ROOM_IDLE_MS = 30 * 60 * 1000;
const MAX_PLAYERS = 6;
const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ'; // excludes I, O and L

type Player = { id: string; nickname: string; seat: number; color: string; connected: boolean; joinedAt: number };
type Phase = 'lobby' | 'shift' | 'over';
type Sim = {
  shift: Shift; difficulty: Difficulty; players: number; rng: Rng;
  tick: number; elapsed: number; lastWall: number; nextSpawnAt: number;
  score: number; landings: number; lost: number; strikesUsed: number; strikesAllowed: number;
  planes: Plane[]; airports: Airport[]; nextPlaneId: number; usedCallsigns: Set<string>;
};
type Room = {
  code: string; hostId: string; players: Map<string, Player>; createdAt: number; lastActiveAt: number;
  settings: { shift: number; difficulty: Difficulty }; reconnectTokens: Map<string, string>;
  phase: Phase; sim?: Sim; lastResult?: ShiftResult;
};
type ShiftResult = { score: number; landings: number; lost: number; strikesUsed: number; strikesAllowed: number; elapsed: number; reason: 'timer' | 'strikes' };

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
function shiftFor(n: number): Shift { return SHIFTS.find(s => (s.number === 'endless' ? 8 : s.number) === n) ?? SHIFTS[0]; }
function publicRoom(room: Room) {
  return {
    code: room.code, hostId: room.hostId, phase: room.phase,
    players: [...room.players.values()].map(p => ({ id: p.id, nickname: p.nickname, seat: p.seat, color: p.color, connected: p.connected })),
    settings: room.settings, maxPlayers: MAX_PLAYERS,
  };
}
function broadcast(room: Room) { io.to(room.code).emit('lobby_state', publicRoom(room)); }
function fail(socket: Socket, message: string) { socket.emit('room_error', { message }); }
function roomOf(socket: Socket): { room: Room; player: Player } | null {
  const bound = socketPlayers.get(socket.id);
  const room = bound && rooms.get(bound.code);
  const player = room?.players.get(bound!.playerId);
  return room && player ? { room, player } : null;
}
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

// ─── simulation ────────────────────────────────────────────────────

const r1 = (v: number) => Math.round(v * 10) / 10;
/** Static per-plane data: sent once on spawn and in full syncs. */
function planeInfo(p: Plane) {
  return { id: p.id, cs: p.callsign, t: p.type, d: p.destinationId, mf: p.maxFuel, path: p.path, pv: p.pathVersion, ll: p.landingLocked };
}
/** Compact moving state: sent 15× per second. */
function planeState(p: Plane) {
  return { id: p.id, x: r1(p.position.x), y: r1(p.position.y), h: Math.round(p.heading), f: r1(p.fuel), pv: p.pathVersion, pr: p.path.length };
}
function snapshot(room: Room) {
  const sim = room.sim!;
  return {
    tick: sim.tick, serverTime: Date.now(), elapsed: r1(sim.elapsed),
    length: sim.shift.lengthSeconds, score: sim.score, landings: sim.landings,
    strikesUsed: sim.strikesUsed, strikesAllowed: sim.strikesAllowed,
    planes: sim.planes.map(planeState),
  };
}
function fullSync(room: Room) {
  const sim = room.sim!;
  return { shift: { id: sim.shift.id, name: sim.shift.name, number: sim.shift.number, lengthSeconds: sim.shift.lengthSeconds }, players: sim.players, airports: sim.airports, planes: sim.planes.map(planeInfo), snapshot: snapshot(room) };
}

function startShift(room: Room) {
  const shift = shiftFor(room.settings.shift);
  const players = Math.max(1, room.players.size);
  const diff = DIFFICULTY[room.settings.difficulty];
  room.sim = {
    shift, difficulty: room.settings.difficulty, players, rng: mulberry32(shift.seed ^ (Date.now() & 0xffff)),
    tick: 0, elapsed: 0, lastWall: Date.now(), nextSpawnAt: 0.5,
    score: 0, landings: 0, lost: 0, strikesUsed: 0, strikesAllowed: diff.strikes,
    planes: [], airports: makeAirports(players), nextPlaneId: 1, usedCallsigns: new Set(),
  };
  room.phase = 'shift';
  room.lastResult = undefined;
  io.to(room.code).emit('shift_started', fullSync(room));
  broadcast(room);
}

function newCallsign(sim: Sim): string {
  for (let i = 0; i < 50; i++) {
    const cs = `${CALLSIGN_PREFIXES[Math.floor(sim.rng() * CALLSIGN_PREFIXES.length)]} ${Math.floor(10 + sim.rng() * 890)}`;
    if (!sim.usedCallsigns.has(cs)) { sim.usedCallsigns.add(cs); return cs; }
  }
  return `HDF ${sim.nextPlaneId}`;
}

function spawnPlane(room: Room): Plane | null {
  const sim = room.sim!;
  const at = findSpawn(sim.planes, sim.rng);
  if (!at) return null;
  const type = pickWeighted(sim.shift.aircraftMix as Record<AircraftType, number>, sim.rng);
  const spec = AIRCRAFT[type];
  // medevac may use any airport; everything else gets a specific destination
  const dest = sim.airports[Math.floor(sim.rng() * sim.airports.length)];
  const plane: Plane = {
    id: `p${sim.nextPlaneId++}`, callsign: newCallsign(sim), type,
    position: at.position, heading: at.heading, fuel: spec.fuel, maxFuel: spec.fuel,
    destinationId: dest.id, path: [], pathVersion: 0, landingLocked: false, status: 'flying',
  };
  sim.planes.push(plane);
  io.to(room.code).emit('plane_spawned', planeInfo(plane));
  return plane;
}

function endShift(room: Room, reason: ShiftResult['reason']) {
  const sim = room.sim!;
  room.phase = 'over';
  room.lastResult = { score: sim.score, landings: sim.landings, lost: sim.lost, strikesUsed: sim.strikesUsed, strikesAllowed: sim.strikesAllowed, elapsed: r1(sim.elapsed), reason };
  io.to(room.code).emit('snapshot', snapshot(room));
  io.to(room.code).emit('shift_over', room.lastResult);
  broadcast(room);
}

function tickRoom(room: Room, now: number) {
  const sim = room.sim!;
  const dt = Math.min(0.1, Math.max(0, (now - sim.lastWall) / 1000));
  sim.lastWall = now;
  room.lastActiveAt = now; // a running shift is never idle
  sim.tick++;
  sim.elapsed += dt;

  // spawning
  const cap = PLAYER_SCALING[Math.min(6, sim.players)]?.maxPlanes ?? 8;
  if (sim.elapsed >= sim.nextSpawnAt) {
    if (sim.planes.length < cap) spawnPlane(room);
    sim.nextSpawnAt = sim.elapsed + spawnInterval(sim.players, sim.elapsed, DIFFICULTY[sim.difficulty].spawnMult);
  }

  // movement, landings, fuel
  for (const plane of sim.planes) {
    const r = stepPlane(plane, dt, sim.airports);
    if (r.landed) {
      sim.score += AIRCRAFT[plane.type].points;
      sim.landings++;
      io.to(room.code).emit('fx', { kind: 'landed', planeId: plane.id, airportId: r.landed.id, points: AIRCRAFT[plane.type].points, x: r1(plane.position.x), y: r1(plane.position.y) });
    } else if (r.lost) {
      sim.lost++;
      sim.strikesUsed++;
      io.to(room.code).emit('fx', { kind: 'lost', reason: r.lost, planeId: plane.id, callsign: plane.callsign, x: r1(plane.position.x), y: r1(plane.position.y) });
    }
  }
  sim.planes = sim.planes.filter(p => p.status === 'flying');

  // snapshots at SNAPSHOTS_PER_SECOND out of SIM_TICKS_PER_SECOND ticks
  const per = SNAPSHOTS_PER_SECOND / SIM_TICKS_PER_SECOND;
  if (Math.floor(sim.tick * per) !== Math.floor((sim.tick - 1) * per)) io.to(room.code).emit('snapshot', snapshot(room));

  if (sim.strikesUsed >= sim.strikesAllowed) endShift(room, 'strikes');
  else if (sim.shift.lengthSeconds !== null && sim.elapsed >= sim.shift.lengthSeconds) endShift(room, 'timer');
}

const simTimer = setInterval(() => {
  const now = Date.now();
  for (const room of rooms.values()) if (room.phase === 'shift' && room.sim) tickRoom(room, now);
}, 1000 / SIM_TICKS_PER_SECOND);
simTimer.unref();

// ─── http ──────────────────────────────────────────────────────────

app.disable('x-powered-by');
app.get('/health', (_req, res) => res.status(200).json({ ok: true, service: 'handoff', rooms: rooms.size, uptimeSeconds: Math.floor(process.uptime()) }));
app.get('/api/status', (_req, res) => res.json({ ok: true, rooms: rooms.size, maxPlayers: MAX_PLAYERS }));
app.use(express.static(path.join(__dirname, '../public')));
app.get('*', (_req, res) => res.sendFile(path.join(__dirname, '../public/index.html')));

// ─── sockets ───────────────────────────────────────────────────────

function sendCurrentState(socket: Socket, room: Room) {
  if (room.phase === 'shift' && room.sim) socket.emit('shift_started', fullSync(room));
  else if (room.phase === 'over' && room.lastResult) { if (room.sim) socket.emit('shift_started', fullSync(room)); socket.emit('shift_over', room.lastResult); }
}

io.on('connection', socket => {
  socket.on('create_room', (payload: { nickname?: unknown } = {}) => {
    const nickname = cleanNickname(payload.nickname);
    if (!nickname) return fail(socket, 'Enter a nickname (1–18 characters).');
    const code = createCode();
    const playerId = socket.id;
    const player: Player = { id: playerId, nickname, seat: 0, color: AIRPORT_STYLES[0].color, connected: true, joinedAt: Date.now() };
    const room: Room = { code, hostId: playerId, players: new Map([[playerId, player]]), createdAt: Date.now(), lastActiveAt: Date.now(), settings: { shift: 1, difficulty: 'controller' }, reconnectTokens: new Map(), phase: 'lobby' };
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
        player.connected = true; bindPlayer(socket, room, player);
        socket.emit('room_joined', { room: publicRoom(room), reconnectToken: token, playerId }); broadcast(room);
        sendCurrentState(socket, room);
        return;
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
    sendCurrentState(socket, room);
  });

  socket.on('set_settings', (payload: { shift?: unknown; difficulty?: unknown } = {}) => {
    const ctx = roomOf(socket);
    if (!ctx || ctx.room.hostId !== ctx.player.id) return fail(socket, 'Only the room host can change settings.');
    const { room } = ctx;
    if (room.phase === 'shift') return fail(socket, 'Settings are locked during a shift.');
    if (Number.isInteger(payload.shift) && Number(payload.shift) >= 1 && Number(payload.shift) <= 8) room.settings.shift = Number(payload.shift);
    if (payload.difficulty === 'cadet' || payload.difficulty === 'controller' || payload.difficulty === 'chief') room.settings.difficulty = payload.difficulty;
    room.lastActiveAt = Date.now(); broadcast(room);
  });

  socket.on('start_shift', () => {
    const ctx = roomOf(socket);
    if (!ctx || ctx.room.hostId !== ctx.player.id) return fail(socket, 'Only the host can start the shift.');
    if (ctx.room.phase === 'shift') return fail(socket, 'This shift is already running.');
    startShift(ctx.room); ctx.room.lastActiveAt = Date.now();
  });

  socket.on('return_to_lobby', () => {
    const ctx = roomOf(socket);
    if (!ctx || ctx.room.hostId !== ctx.player.id) return fail(socket, 'Only the host can return the crew to the lobby.');
    if (ctx.room.phase === 'shift') return;
    ctx.room.phase = 'lobby'; ctx.room.sim = undefined; ctx.room.lastActiveAt = Date.now(); broadcast(ctx.room);
  });

  socket.on('draw_path', (payload: { planeId?: unknown; points?: unknown; seq?: unknown } = {}) => {
    const ctx = roomOf(socket);
    const sim = ctx?.room.sim;
    const seq = typeof payload.seq === 'number' ? payload.seq : 0;
    if (!ctx || ctx.room.phase !== 'shift' || !sim) return;
    const plane = sim.planes.find(p => p.id === payload.planeId && p.status === 'flying');
    if (!plane) return socket.emit('path_rejected', { planeId: payload.planeId, seq, reason: 'gone' });
    // M2: one shared sector, every controller may steer every plane. Sector ownership arrives in M3.
    const check = preparePath(plane, payload.points, sim.airports);
    if (!check.ok) return socket.emit('path_rejected', { planeId: plane.id, seq, reason: check.reason });
    plane.path = check.points; plane.landingLocked = check.landingLocked; plane.pathVersion++;
    ctx.room.lastActiveAt = Date.now();
    io.to(ctx.room.code).emit('path_set', { planeId: plane.id, path: plane.path, pv: plane.pathVersion, ll: plane.landingLocked, seq, by: ctx.player.id });
  });

  socket.on('request_sync', () => {
    const ctx = roomOf(socket);
    if (ctx) sendCurrentState(socket, ctx.room);
  });
  socket.on('ping_room', () => { const ctx = roomOf(socket); if (ctx) ctx.room.lastActiveAt = Date.now(); socket.emit('pong_room', { at: Date.now() }); });
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
