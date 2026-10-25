import { describe, expect, it } from 'vitest';
import {
  angleDiff, dirOf, distance, findSpawn, headingTo, inApproachCone, makeAirports, mulberry32,
  preparePath, RIM_TURN_RADIUS, stepPlane, threshold, type Airport, type Plane,
} from '../src/shared/engine.js';
import { AIRCRAFT, SKY_RADIUS } from '../src/shared/HANDOFF_DATA.js';

const airport: Airport = { id: 'ap0', styleIndex: 0, seat: 0, position: { x: 0, y: 0 }, runwayHeading: 90, runwayLength: 90 };
const plane = (over: Partial<Plane> = {}): Plane => ({
  id: 'p1', callsign: 'MNP 214', type: 'regional', position: { x: -400, y: 0 }, heading: 90, fuel: 60, maxFuel: 60,
  destinationId: 'ap0', path: [], pathVersion: 0, landingLocked: false, status: 'flying', ...over,
});
const run = (p: Plane, seconds: number, airports = [airport]) => {
  for (let t = 0; t < seconds; t += 0.05) { const r = stepPlane(p, 0.05, airports); if (r.landed || r.lost) return r; }
  return {};
};

describe('geometry', () => {
  it('uses 0° = north, clockwise', () => {
    expect(headingTo({ x: 0, y: 0 }, { x: 0, y: -10 })).toBeCloseTo(0);
    expect(headingTo({ x: 0, y: 0 }, { x: 10, y: 0 })).toBeCloseTo(90);
    expect(dirOf(180).y).toBeCloseTo(1);
    expect(angleDiff(350, 10)).toBeCloseTo(20);
  });
  it('places the approach cone behind the threshold, facing the runway direction', () => {
    const t = threshold(airport); // runway runs west→east, threshold on the west end
    expect(t.x).toBeCloseTo(-45);
    expect(inApproachCone({ x: -120, y: 0 }, airport)).toBe(true);   // straight behind
    expect(inApproachCone({ x: -120, y: 60 }, airport)).toBe(false); // too far off-axis
    expect(inApproachCone({ x: 120, y: 0 }, airport)).toBe(false);   // wrong end
  });
  it('lays out one coloured airport per sector, inside the sky', () => {
    for (const n of [1, 2, 3, 4, 5, 6]) {
      const aps = makeAirports(n);
      expect(new Set(aps.map(a => a.styleIndex)).size).toBe(aps.length);
      for (const a of aps) expect(Math.hypot(a.position.x, a.position.y)).toBeLessThan(SKY_RADIUS * 0.75);
    }
  });
});

describe('flight', () => {
  it('flies straight when it has no path', () => {
    const p = plane();
    stepPlane(p, 1, [airport]);
    expect(p.position.x).toBeCloseTo(-400 + AIRCRAFT.regional.speed);
    expect(p.position.y).toBeCloseTo(0);
    expect(p.fuel).toBeCloseTo(59);
  });
  it('turns back at the rim instead of leaving the sky', () => {
    const p = plane({ position: { x: RIM_TURN_RADIUS - 5, y: 0 }, heading: 90, fuel: 999 });
    let maxR = 0;
    for (let i = 0; i < 400; i++) { stepPlane(p, 0.05, []); maxR = Math.max(maxR, Math.hypot(p.position.x, p.position.y)); }
    expect(maxR).toBeLessThan(SKY_RADIUS * 1.02);
    expect(Math.hypot(p.position.x, p.position.y)).toBeLessThan(RIM_TURN_RADIUS);
  });
  it('follows a drawn path, then carries straight on along its last heading', () => {
    const p = plane({ position: { x: 0, y: 300 }, path: [{ x: 0, y: 200 }, { x: 100, y: 200 }], fuel: 999 });
    for (let i = 0; i < 120; i++) stepPlane(p, 0.05, []); // 6 s × 40 u/s = 240 u: 200 of path + 40 straight
    expect(p.path).toEqual([]);
    expect(p.heading).toBeCloseTo(90);
    expect(p.position.x).toBeCloseTo(140, 0);
    expect(p.position.y).toBeCloseTo(200, 0);
  });
  it('is lost when fuel runs out', () => {
    const p = plane({ fuel: 1, position: { x: 0, y: 500 }, heading: 180 });
    expect(run(p, 3)).toEqual({ lost: 'fuel' });
    expect(p.status).toBe('lost');
  });
});

describe('landing', () => {
  it('a path ending in the cone is finished onto the runway and lands', () => {
    const p = plane({ position: { x: -300, y: 150 } });
    const prep = preparePath(p, [{ x: -200, y: 60 }, { x: -110, y: 4 }], [airport]);
    expect(prep.ok).toBe(true);
    if (!prep.ok) return;
    expect(prep.landingLocked).toBe(true);
    p.path = prep.points;
    const r = run(p, 20);
    expect(r.landed?.id).toBe('ap0');
    expect(p.status).toBe('landed');
  });
  it('a path drawn straight onto the airport centre from the side does not snap', () => {
    const p = plane({ position: { x: 0, y: 300 } });
    const prep = preparePath(p, [{ x: 0, y: 0 }], [airport]);
    expect(prep.ok && prep.landingLocked).toBe(false);
  });
  it('never lands at the wrong airport', () => {
    const other: Airport = { ...airport, id: 'ap1', styleIndex: 1 };
    const p = plane({ destinationId: 'ap1', position: { x: -400, y: 0 }, heading: 90 });
    // flies straight down ap0's centreline; ap1 is far away
    const r = run(p, 15, [airport, { ...other, position: { x: 0, y: 700 } }]);
    expect(r.landed).toBeUndefined();
  });
  it('rejects paths that are too long', () => {
    const p = plane({ position: { x: -900, y: 0 } });
    const zigzag = Array.from({ length: 30 }, (_, i) => ({ x: -900 + i * 60, y: i % 2 ? 300 : -300 }));
    expect(preparePath(p, zigzag, [airport])).toEqual({ ok: false, reason: 'too-long' });
  });
});

describe('spawning', () => {
  it('is deterministic from the seed and keeps clear of other planes', () => {
    const a = findSpawn([], mulberry32(42)), b = findSpawn([], mulberry32(42));
    expect(a).toEqual(b);
    const blocker = plane({ position: a!.position });
    const c = findSpawn([blocker], mulberry32(42));
    expect(c && distance(c.position, blocker.position)).toBeGreaterThan(100);
  });
});
