import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { io as clientIO, Socket } from 'socket.io-client';
import { server, rooms } from '../src/server.js';
let url = '';
let a: Socket;
let b: Socket;
const waitFor = <T>(socket: Socket, event: string) => new Promise<T>((resolve, reject) => {
  const timeout = setTimeout(() => reject(new Error(`Timed out waiting for ${event}`)), 3000);
  socket.once(event, (data: T) => { clearTimeout(timeout); resolve(data); });
});
beforeAll(async () => { await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); const address = server.address(); if (address && typeof address !== 'string') url = `http://127.0.0.1:${address.port}`; });
afterAll(async () => { a?.disconnect(); b?.disconnect(); await new Promise<void>(resolve => server.close(() => resolve())); rooms.clear(); });
describe('M1 room lobby two-client test', () => {
  it('creates a valid room and lets a second client join the same live lobby', async () => {
    a = clientIO(url, { transports: ['websocket'] }); b = clientIO(url, { transports: ['websocket'] });
    await Promise.all([waitFor<void>(a, 'connect'), waitFor<void>(b, 'connect')]);
    const createdPromise = waitFor<{ room: { code: string; players: { nickname: string }[] }; reconnectToken: string }>(a, 'room_created');
    a.emit('create_room', { nickname: 'Aster' }); const created = await createdPromise;
    expect(created.room.code).toMatch(/^[A-HJ-KM-NP-Z]{4}$/);
    const joinedPromise = waitFor<{ room: { code: string; players: { nickname: string }[] } }>(b, 'room_joined');
    b.emit('join_room', { code: created.room.code, nickname: 'Beacon' }); const joined = await joinedPromise;
    expect(joined.room.code).toBe(created.room.code);
    expect(joined.room.players.map(p => p.nickname).sort()).toEqual(['Aster', 'Beacon']);
  });
});
