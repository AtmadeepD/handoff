/**
 * HANDOFF game engine — pure, deterministic, shared by server and tests.
 * Coordinates: sky centre (0,0), y grows southward (screen-like).
 * Headings: degrees, 0 = north (−y), clockwise.
 * All tuning values come from HANDOFF_DATA.ts.
 */
import {
  AIRCRAFT, AIRPORT_RADIAL_POSITION, AIRPORT_RADIAL_POSITIONS_2, AIRPORT_STYLES, APPROACH_CONE,
  MAX_PATH_LENGTH, MAX_PATH_POINTS, PLAYER_SCALING, RUNWAY, SEPARATION, SKY_RADIUS, type AircraftType,
} from './HANDOFF_DATA.js';

export type Vec = { x: number; y: number };

export type Airport = {
  id: string;
  styleIndex: number;      // index into AIRPORT_STYLES (colour + shape)
  seat: number;            // sector that owns it
  position: Vec;           // runway centre
  runwayHeading: number;   // direction a landing plane travels along the runway
  runwayLength: number;
};

export type PlaneStatus = 'flying' | 'landed' | 'lost';

export type Plane = {
  id: string;
  callsign: string;
  type: AircraftType;
  position: Vec;
  heading: number;
  fuel: number;
  maxFuel: number;
  destinationId: string;
  path: Vec[];             // remaining waypoints, consumed from the front
  pathVersion: number;
  landingLocked: boolean;  // path ends on its runway: plane will land when it reaches the threshold
  status: PlaneStatus;
};

/** Distance from the runway threshold at which a correctly aligned plane touches down. */
export const TOUCHDOWN_RADIUS = 16;
/** Max difference between plane heading and runway heading for a valid touchdown. */
export const TOUCHDOWN_ALIGN_DEG = 50;
/** A path ending this close to the threshold also counts as "into the cone". */
export const THRESHOLD_SNAP_RADIUS = 36;
/** Planes beyond this radius turn back toward the centre. */
export const RIM_TURN_RADIUS = SKY_RADIUS * 0.97;

// ─── vector helpers ────────────────────────────────────────────────

export const distance = (a: Vec, b: Vec) => Math.hypot(a.x - b.x, a.y - b.y);
export const dirOf = (headingDeg: number): Vec => {
  const r = (headingDeg * Math.PI) / 180;
  return { x: Math.sin(r), y: -Math.cos(r) };
};
export const headingTo = (from: Vec, to: Vec) =>
  ((Math.atan2(to.x - from.x, -(to.y - from.y)) * 180) / Math.PI + 360) % 360;
export const angleDiff = (a: number, b: number) => Math.abs(((a - b + 540) % 360) - 180);
export function pathLength(points: Vec[]): number {
  let n = 0;
  for (let i = 1; i < points.length; i++) n += distance(points[i - 1], points[i]);
  return n;
}

// ─── airports ──────────────────────────────────────────────────────

/** Runway threshold: the end a landing plane crosses first. */
export function threshold(a: Airport): Vec {
  const d = dirOf(a.runwayHeading);
  return { x: a.position.x - (d.x * a.runwayLength) / 2, y: a.position.y - (d.y * a.runwayLength) / 2 };
}
export function runwayEnd(a: Airport): Vec {
  const d = dirOf(a.runwayHeading);
  return { x: a.position.x + (d.x * a.runwayLength) / 2, y: a.position.y + (d.y * a.runwayLength) / 2 };
}

/** True when p lies inside the airport's approach cone (fans out behind the threshold). */
export function inApproachCone(p: Vec, a: Airport): boolean {
  const t = threshold(a);
  const back = dirOf((a.runwayHeading + 180) % 360);
  const vx = p.x - t.x, vy = p.y - t.y;
  const along = vx * back.x + vy * back.y;
  if (along < -4 || along > APPROACH_CONE.length) return false;
  const len = Math.hypot(vx, vy);
  if (len < THRESHOLD_SNAP_RADIUS) return true;
  return angleDiff(headingTo(t, p), (a.runwayHeading + 180) % 360) <= APPROACH_CONE.widthDeg / 2;
}

/** Wedge geometry: sector `seat` of `n` spans [start, start + 360/n) degrees, sector 0 centred on north. */
export function sectorBisector(seat: number, n: number): number {
  return (seat * 360) / Math.max(1, n);
}

/** Lay out airports for `players` seats. Deterministic so every client and test agrees. */
export function makeAirports(players: number): Airport[] {
  const n = Math.max(1, Math.min(6, players));
  const perSector = PLAYER_SCALING[n]?.airportsPerSector ?? 1;
  const airports: Airport[] = [];
  let style = 0;
  for (let seat = 0; seat < n; seat++) {
    const bis = sectorBisector(seat, n);
    const radii = perSector === 1 ? [AIRPORT_RADIAL_POSITION]
      : perSector === 2 ? AIRPORT_RADIAL_POSITIONS_2
      : [0.32, 0.6, 0.32, 0.6].slice(0, perSector);
    radii.forEach((rf, j) => {
      // spread multiple airports sideways inside the wedge
      const spread = perSector === 1 ? 0 : perSector === 2 ? (j === 0 ? -14 : 14) : [-50, -20, 20, 50][j];
      const ang = ((bis + spread) * Math.PI) / 180;
      const r = SKY_RADIUS * rf;
      // runways roughly tangential, alternating direction, so cones face different ways
      const runwayHeading = (bis + 90 + (j % 2) * 180 + seat * 23) % 360;
      airports.push({
        id: `ap${style}`,
        styleIndex: style % AIRPORT_STYLES.length,
        seat,
        position: { x: Math.sin(ang) * r, y: -Math.cos(ang) * r },
        runwayHeading,
        runwayLength: j === 0 ? RUNWAY.longLength : RUNWAY.shortLength,
      });
      style++;
    });
  }
  return airports;
}

// ─── paths ─────────────────────────────────────────────────────────

export type PathCheck = { ok: true; points: Vec[]; landingLocked: boolean } | { ok: false; reason: string };

/** Validate a drawn path for `plane` and, if it ends in the destination's cone, finish it on the runway. */
export function preparePath(plane: Plane, raw: unknown, airports: Airport[]): PathCheck {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > MAX_PATH_POINTS) return { ok: false, reason: 'bad-points' };
  const pts: Vec[] = [];
  for (const p of raw) {
    if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) return { ok: false, reason: 'bad-points' };
    // clamp into the sky
    const r = Math.hypot(p.x, p.y);
    const k = r > SKY_RADIUS ? SKY_RADIUS / r : 1;
    pts.push({ x: p.x * k, y: p.y * k });
  }
  // drop leading points the plane is effectively already at
  while (pts.length && distance(pts[0], plane.position) < 6) pts.shift();
  if (!pts.length) return { ok: false, reason: 'too-short' };
  if (pathLength([plane.position, ...pts]) > MAX_PATH_LENGTH) return { ok: false, reason: 'too-long' };

  const dest = airports.find(a => a.id === plane.destinationId);
  const last = pts[pts.length - 1];
  let landingLocked = false;
  if (dest && inApproachCone(last, dest)) {
    const t = threshold(dest);
    if (distance(last, t) > 2) pts.push(t);
    pts.push(runwayEnd(dest));
    landingLocked = true;
  }
  return { ok: true, points: pts, landingLocked };
}

// ─── simulation step ───────────────────────────────────────────────

export type StepResult = { landed?: Airport; lost?: 'fuel' };

/** Advance one plane by dt seconds. Mutates and returns what happened. */
export function stepPlane(plane: Plane, dt: number, airports: Airport[]): StepResult {
  if (plane.status !== 'flying') return {};
  const spec = AIRCRAFT[plane.type];
  plane.fuel = Math.max(0, plane.fuel - dt);
  let budget = spec.speed * dt;

  // follow the path exactly (Flight-Control style)
  while (budget > 0 && plane.path.length) {
    const target = plane.path[0];
    const d = distance(plane.position, target);
    if (d < 1e-6) { plane.path.shift(); continue; }
    plane.heading = headingTo(plane.position, target);
    if (d <= budget) { plane.position = { ...target }; budget -= d; plane.path.shift(); }
    else {
      plane.position = { x: plane.position.x + ((target.x - plane.position.x) / d) * budget, y: plane.position.y + ((target.y - plane.position.y) / d) * budget };
      budget = 0;
    }
    // touchdown check while on the path
    const r = checkTouchdown(plane, airports);
    if (r) return r;
  }

  // no path left: fly straight, turning back at the rim
  if (budget > 0) {
    const out = Math.hypot(plane.position.x, plane.position.y) > RIM_TURN_RADIUS;
    if (out) {
      const home = headingTo(plane.position, { x: 0, y: 0 });
      const maxTurn = spec.turnRateDegPerSec * dt;
      const delta = ((home - plane.heading + 540) % 360) - 180;
      plane.heading = (plane.heading + Math.max(-maxTurn, Math.min(maxTurn, delta)) + 360) % 360;
    }
    const d = dirOf(plane.heading);
    plane.position = { x: plane.position.x + d.x * budget, y: plane.position.y + d.y * budget };
    const r = checkTouchdown(plane, airports);
    if (r) return r;
  }

  if (plane.fuel <= 0) { plane.status = 'lost'; return { lost: 'fuel' }; }
  return {};
}

function checkTouchdown(plane: Plane, airports: Airport[]): StepResult | null {
  const dest = airports.find(a => a.id === plane.destinationId);
  if (!dest) return null;
  const t = threshold(dest);
  if (distance(plane.position, t) <= TOUCHDOWN_RADIUS && angleDiff(plane.heading, dest.runwayHeading) <= TOUCHDOWN_ALIGN_DEG) {
    plane.status = 'landed';
    plane.path = [];
    return { landed: dest };
  }
  return null;
}

// ─── spawning ──────────────────────────────────────────────────────

export type Rng = () => number;

/** Seeded PRNG (mulberry32) so a shift replays identically from its seed. */
export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function pickWeighted<T extends string>(mix: Partial<Record<T, number>>, rng: Rng): T {
  const entries = Object.entries(mix) as [T, number][];
  const total = entries.reduce((s, [, w]) => s + w, 0);
  let roll = rng() * total;
  for (const [k, w] of entries) { roll -= w; if (roll <= 0) return k; }
  return entries[entries.length - 1][0];
}

/** Find a rim spawn point that keeps clear of existing planes (fairness rule). */
export function findSpawn(existing: Plane[], rng: Rng): { position: Vec; heading: number } | null {
  for (let attempt = 0; attempt < 12; attempt++) {
    const ang = rng() * Math.PI * 2;
    const r = SKY_RADIUS * 0.95;
    const position = { x: Math.sin(ang) * r, y: -Math.cos(ang) * r };
    if (existing.some(p => p.status === 'flying' && distance(p.position, position) < SEPARATION.warningDistance * 2.5)) continue;
    // aim roughly at the centre, ±25°
    const heading = (headingTo(position, { x: 0, y: 0 }) + (rng() - 0.5) * 50 + 360) % 360;
    return { position, heading };
  }
  return null;
}
