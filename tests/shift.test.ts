import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { io as clientIO, Socket } from 'socket.io-client';
import { server, rooms } from '../src/server.js';
import { inApproachCone, threshold, type Airport } from '../src/shared/engine.js';

let url = '';
const sockets: Socket[] = [];
const connect = async () => {
  const s = clientIO(url, { transports: ['websocket'] });
  sockets.push(s);
  await new Promise<void>(r => s.once('connect', () => r()));
  return s;
};
const next = <T>(s: Socket, event: string, ms = 4000) => new Promise<T>((resolve, reject) => {
  const t = setTimeout(() => reject(new Error(`timeout waiting for ${event}`)), ms);
  s.once(event, (d: T) => { clearTimeout(t); resolve(d); });
});
const collect = <T>(s: Socket, event: string, ms: number) => new Promise<T[]>(resolve => {
  const got: T[] = []; const h = (d: T) => got.push(d); s.on(event, h);
  setTimeout(() => { s.off(event, h); resolve(got); }, ms);
});

type Sync = { airports: Airport[]; planes: { id: string; d: string }[]; snapshot: { planes: { id: string; x: number; y: number; h: number }[] } };
type Snap = { serverTime: number; elapsed: number; planes: { id: string; x: number; y: number }[] };

beforeAll(async () => {
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const a = server.address(); if (a && typeof a !== 'string') url = `http://127.0.0.1:${a.port}`;
});
afterAll(async () => { sockets.forEach(s => s.disconnect()); rooms.clear(); await new Promise<void>(r => server.close(() => r())); });

describe('M2 shared shift', () => {
  it('host starts a shift; both devices see the same moving planes at ~15 Hz and the same paths', async () => {
    const host = await connect(), guest = await connect();
    const created = next<{ room: { code: string } }>(host, 'room_created');
    host.emit('create_room', { nickname: 'Host' });
    const code = (await created).room.code;
    const joined = next(guest, 'room_joined');
    guest.emit('join_room', { code, nickname: 'Guest' });
    await joined;

    // only the host may start
    const denied = next<{ message: string }>(guest, 'room_error');
    guest.emit('start_shift');
    expect((await denied).message).toMatch(/host/i);

    const spawned: { id: string; d: string }[] = [];
    host.on('plane_spawned', (p: { id: string; d: string }) => spawned.push(p));
    const hostSync = next<Sync>(host, 'shift_started'), guestSync = next<Sync>(guest, 'shift_started');
    host.emit('start_shift');
    const [hs, gs] = await Promise.all([hostSync, guestSync]);
    expect(gs.airports).toEqual(hs.airports);
    expect(hs.airports.length).toBe(4); // 2 players → 2 airports per sector

    // snapshots: roughly 15 per second, identical on both devices
    const [hSnaps, gSnaps] = await Promise.all([collect<Snap>(host, 'snapshot', 1000), collect<Snap>(guest, 'snapshot', 1000)]);
    expect(hSnaps.length).toBeGreaterThanOrEqual(11);
    expect(hSnaps.length).toBeLessThanOrEqual(18);
    const lastH = hSnaps[hSnaps.length - 1];
    const sameTick = gSnaps.find(s => s.serverTime === lastH.serverTime);
    expect(sameTick?.planes).toEqual(lastH.planes);

    // at least one plane exists and is actually moving
    expect(lastH.planes.length).toBeGreaterThan(0);
    const id = lastH.planes[0].id;
    const firstPos = hSnaps.find(s => s.planes.some(p => p.id === id))!.planes.find(p => p.id === id)!;
    const lastPos = lastH.planes.find(p => p.id === id)!;
    expect(Math.hypot(lastPos.x - firstPos.x, lastPos.y - firstPos.y)).toBeGreaterThan(5);

    // the guest draws a landing path; both devices receive it, locked onto the runway
    const meta = [...hs.planes, ...spawned].find(p => p.id === id)!;
    expect(meta).toBeDefined();
    const dest = hs.airports.find(a => a.id === meta.d)!;
    const t = threshold(dest);
    const back = ((dest.runwayHeading + 180) * Math.PI) / 180;
    const inCone = { x: t.x + Math.sin(back) * 80, y: t.y - Math.cos(back) * 80 };
    expect(inApproachCone(inCone, dest)).toBe(true);
    const hp = next<{ planeId: string; ll: boolean; path: unknown[] }>(host, 'path_set'), gp = next<{ planeId: string; ll: boolean; seq: number }>(guest, 'path_set');
    guest.emit('draw_path', { planeId: id, points: [inCone], seq: 7 });
    const [hpath, gpath] = await Promise.all([hp, gp]);
    expect(hpath.planeId).toBe(id);
    expect(hpath.ll).toBe(true);
    expect(gpath.seq).toBe(7);

    // garbage input is rejected without crashing the room
    const rej = next<{ reason: string }>(guest, 'path_rejected');
    guest.emit('draw_path', { planeId: id, points: 'nope', seq: 8 });
    expect((await rej).reason).toBe('bad-points');
  });

  it('a player who refreshes mid-shift gets the live game back', async () => {
    const host = await connect();
    const created = next<{ room: { code: string }; reconnectToken: string }>(host, 'room_created');
    host.emit('create_room', { nickname: 'Solo' });
    const { room, reconnectToken } = await created;
    const started = next<Sync>(host, 'shift_started');
    host.emit('start_shift');
    await started;
    host.disconnect();

    const again = await connect();
    const sync = next<Sync>(again, 'shift_started');
    again.emit('join_room', { code: room.code, reconnectToken });
    const s = await sync;
    expect(s.airports.length).toBe(4); // solo practice: 4 airports
  });
});
