/**
 * HANDOFF — machine-readable game data (v1, 2026-10-25)
 *
 * This file is the single source of truth for every number in the game.
 * The HANDOFF_BIBLE explains WHY; this file says WHAT.
 * Engine code must read from these exports, never hard-code values.
 *
 * Units: sky radius = 1000 units. Speeds in units/second. Times in seconds.
 * Coordinates: sky centre is (0,0). Angles in degrees, 0 = north, clockwise.
 */

// ─────────────────────────────────────────────────────────────
// 1. CORE BALANCE
// ─────────────────────────────────────────────────────────────

export const SKY_RADIUS = 1000;
export const SIM_TICKS_PER_SECOND = 20;
export const SNAPSHOTS_PER_SECOND = 15;
export const CLIENT_INTERP_BUFFER_MS = 100;

export const SEPARATION = {
  warningDistance: 70,        // amber rings + alarm
  crashDistance: 35,          // strike
  heavyMultiplier: 1.4,       // heavy jets: 98 warning / 49 crash
  sameAltitudeOnly: true,     // HIGH and LOW never collide
};

export const APPROACH_CONE = { widthDeg: 30, length: 120 };
export const HANDOFF_ZONE_DISTANCE = 60;      // path end within 60u of a border = handoff
export const INCOMING_GRACE = { seconds: 5, speedFactor: 0.7 };
export const HOLD_FUEL_BURN = 1.5;
export const ALTITUDE_CHANGE_SECONDS = 3;
export const MAX_PATH_LENGTH = 1500;
export const MAX_PATH_POINTS = 40;            // client simplifies (Ramer–Douglas–Peucker)
export const LOW_FUEL_WARNING = 0.25;         // fraction of max fuel
export const EVENT_COOLDOWN_SECONDS = 25;
export const NO_EVENTS_BEFORE_SECONDS = 30;
export const MIN_TELEGRAPH_SECONDS = 5;
export const MAX_CONCURRENT_EVENTS = 2;       // finale overrides to 3

/** Spawn interval in seconds: max(0.4*S, S * 0.9^floor(t/30)), S = 18/players */
export function spawnInterval(players: number, tSeconds: number, difficultyMult = 1): number {
  const n = Math.max(1, players);
  const S = n === 1 ? 12 : 18 / n;
  const raw = Math.max(0.4 * S, S * Math.pow(0.9, Math.floor(tSeconds / 30)));
  return raw / difficultyMult; // higher spawn multiplier = shorter interval
}

export const PLAYER_SCALING: Record<number, {
  airportsPerSector: number; maxPlanes: number; crossSectorShare: number;
}> = {
  1: { airportsPerSector: 4, maxPlanes: 8,  crossSectorShare: 0.0 },
  2: { airportsPerSector: 2, maxPlanes: 10, crossSectorShare: 0.5 },
  3: { airportsPerSector: 1, maxPlanes: 14, crossSectorShare: 0.6 },
  4: { airportsPerSector: 1, maxPlanes: 18, crossSectorShare: 0.65 },
  5: { airportsPerSector: 1, maxPlanes: 22, crossSectorShare: 0.7 },
  6: { airportsPerSector: 1, maxPlanes: 26, crossSectorShare: 0.7 },
};

export const DIFFICULTY = {
  cadet:      { strikes: 5, spawnMult: 0.75, telegraphBonus: 3 },
  controller: { strikes: 3, spawnMult: 1.0,  telegraphBonus: 0 },
  chief:      { strikes: 2, spawnMult: 1.25, telegraphBonus: -1 }, // never below MIN_TELEGRAPH_SECONDS
} as const;
export type Difficulty = keyof typeof DIFFICULTY;

export const SCORING = {
  chainWindowSeconds: 4,
  chainStep: 0.25,
  chainMax: 2.0,
  smoothHandoffSeconds: 3,      // new path within 3s of arrival
  survivalBase: 10,
  survivalPerUnusedStrike: 5,
  grades: { S: 1.2, A: 1.0, B: 0.75, C: 0.5 }, // fraction of shift's 3-star landing target; S also needs 0 strikes
};

// ─────────────────────────────────────────────────────────────
// 2. AIRPORTS (one colour+shape per sector, assigned in seat order)
// ─────────────────────────────────────────────────────────────

export const AIRPORT_STYLES = [
  { id: 'red',    color: '#FF5A5F', shape: 'triangle' },
  { id: 'blue',   color: '#4DA3FF', shape: 'circle'   },
  { id: 'yellow', color: '#FFD23F', shape: 'square'   },
  { id: 'green',  color: '#35E08A', shape: 'diamond'  },
  { id: 'violet', color: '#B57BFF', shape: 'pentagon' },
  { id: 'orange', color: '#FF8A3D', shape: 'cross'    },
] as const;

/** Airport placement inside a wedge: along the wedge bisector at this fraction of radius. */
export const AIRPORT_RADIAL_POSITION = 0.45;   // 1 airport per sector
export const AIRPORT_RADIAL_POSITIONS_2 = [0.3, 0.62]; // 2 airports per sector
export const RUNWAY = { shortLength: 60, longLength: 90, width: 10 };
export const HELIPAD_RADIUS = 14;

// ─────────────────────────────────────────────────────────────
// 3. AIRCRAFT
// ─────────────────────────────────────────────────────────────

export type AircraftType = 'light' | 'regional' | 'freighter' | 'heavy' | 'heli' | 'medevac';

export const AIRCRAFT: Record<AircraftType, {
  label: string; speed: number; fuel: number; points: number;
  turnRateDegPerSec: number; needsLongRunway: boolean; separationMult: number;
  anyAirport: boolean; usesHelipad: boolean; strikeIfLost: boolean; firstShift: number;
}> = {
  light:     { label: 'Light prop',   speed: 30, fuel: 70, points: 1, turnRateDegPerSec: 120, needsLongRunway: false, separationMult: 1.0, anyAirport: false, usesHelipad: false, strikeIfLost: true, firstShift: 1 },
  regional:  { label: 'Regional jet', speed: 40, fuel: 60, points: 1, turnRateDegPerSec: 90,  needsLongRunway: false, separationMult: 1.0, anyAirport: false, usesHelipad: false, strikeIfLost: true, firstShift: 1 },
  freighter: { label: 'Freighter',    speed: 32, fuel: 45, points: 2, turnRateDegPerSec: 60,  needsLongRunway: false, separationMult: 1.0, anyAirport: false, usesHelipad: false, strikeIfLost: true, firstShift: 2 },
  heavy:     { label: 'Heavy jet',    speed: 36, fuel: 65, points: 3, turnRateDegPerSec: 55,  needsLongRunway: true,  separationMult: 1.4, anyAirport: false, usesHelipad: false, strikeIfLost: true, firstShift: 3 },
  heli:      { label: 'Helicopter',   speed: 22, fuel: 80, points: 1, turnRateDegPerSec: 180, needsLongRunway: false, separationMult: 0.8, anyAirport: false, usesHelipad: true,  strikeIfLost: true, firstShift: 4 },
  medevac:   { label: 'Medevac',      speed: 45, fuel: 30, points: 5, turnRateDegPerSec: 100, needsLongRunway: false, separationMult: 1.0, anyAirport: true,  usesHelipad: false, strikeIfLost: true, firstShift: 5 },
};

/** Invented callsign prefixes — no real airlines. */
export const CALLSIGN_PREFIXES = ['MNP', 'BRK', 'SYL', 'IMF', 'KXR', 'TZA', 'VLO', 'QRN', 'HDF', 'ZEP', 'NOV', 'ORA'];

// ─────────────────────────────────────────────────────────────
// 4. EVENTS
// ─────────────────────────────────────────────────────────────

export type EventType =
  | 'storm' | 'rushWave' | 'microburst' | 'radarBlackout' | 'engineFailure'
  | 'birdStrike' | 'noRadio' | 'militaryCorridor' | 'runwayIncursion' | 'ashCloud';

export const EVENTS: Record<EventType, {
  telegraphSeconds: number; durationSeconds: number | 'untilResolved';
  targets: 'sky' | 'sector' | 'runway' | 'plane'; firstShift: number; notes: string;
}> = {
  storm:            { telegraphSeconds: 8,  durationSeconds: 50, targets: 'sky',    firstShift: 3, notes: 'Radius 140–200u, drifts 12u/s across sectors. Paths may not enter; paths through it break and plane holds at edge.' },
  rushWave:         { telegraphSeconds: 6,  durationSeconds: 4,  targets: 'sky',    firstShift: 2, notes: '5–8 planes from one rim direction within 4s. Show arrow on rim + countdown on all screens.' },
  microburst:       { telegraphSeconds: 5,  durationSeconds: 15, targets: 'runway', firstShift: 4, notes: 'Runway closed. Planes on final must be re-routed or go around automatically.' },
  radarBlackout:    { telegraphSeconds: 6,  durationSeconds: 20, targets: 'sector', firstShift: 4, notes: 'Affected player sees static; blips only flash when sweep passes (every 4s). Neighbours still see planes on mini-radar.' },
  engineFailure:    { telegraphSeconds: 5,  durationSeconds: 'untilResolved', targets: 'plane', firstShift: 5, notes: 'MAYDAY: speed x0.6, fuel set to 20s, may land at ANY airport, +5 if saved, strike if lost.' },
  birdStrike:       { telegraphSeconds: 5,  durationSeconds: 'untilResolved', targets: 'plane', firstShift: 5, notes: 'Turn rate halved for rest of flight. Telegraph = feather burst then 5s before control degrades.' },
  noRadio:          { telegraphSeconds: 5,  durationSeconds: 8,  targets: 'plane',  firstShift: 6, notes: 'Plane ignores new paths and flies straight. Projected line shown on all screens.' },
  militaryCorridor: { telegraphSeconds: 6,  durationSeconds: 2,  targets: 'sky',    firstShift: 6, notes: 'Band 80u wide across the sky. Fast jet at 300u/s. Any plane inside when jet passes = strike.' },
  runwayIncursion:  { telegraphSeconds: 5,  durationSeconds: 'untilResolved', targets: 'runway', firstShift: 4, notes: 'Vehicle on runway; owner taps it 3 times to clear. Runway blocked meanwhile.' },
  ashCloud:         { telegraphSeconds: 10, durationSeconds: 60, targets: 'sky',    firstShift: 7, notes: 'Finale only. Grows to ~half the sky. Planes inside: speed x0.6; after 5s inside become MAYDAY. Airports inside close.' },
};

// ─────────────────────────────────────────────────────────────
// 5. SHIFTS (scenario scripts). `t` = seconds from shift start.
// Events with `at` fire at that time (after telegraph). `random` pools
// are drawn by the seeded RNG respecting cooldown + fairness rules.
// ─────────────────────────────────────────────────────────────

export interface ShiftEvent { at: number; type: EventType; params?: Record<string, unknown>; }
export interface Shift {
  id: string; number: number | 'endless'; name: string; mood: string; teaches: string;
  lengthSeconds: number | null; seed: number;
  aircraftMix: Partial<Record<AircraftType, number>>; // weights, normalised at runtime
  unlocks: { hold: boolean; altitude: boolean };
  scripted: ShiftEvent[];
  randomPool: EventType[]; randomEverySeconds?: [number, number];
  threeStar: { landings?: number; maxStrikes?: number; allMaydaysSaved?: boolean; survive?: boolean };
  palette: 'dawn' | 'day' | 'storm' | 'night' | 'alarm' | 'military' | 'ash';
}

export const SHIFTS: Shift[] = [
  {
    id: 'first-light', number: 1, name: 'First Light', mood: 'Calm dawn, soft blue',
    teaches: 'Draw, land, hand off, callouts', lengthSeconds: 180, seed: 1101,
    aircraftMix: { regional: 70, light: 30 }, unlocks: { hold: false, altitude: false },
    scripted: [], randomPool: [], threeStar: { landings: 15, maxStrikes: 0 }, palette: 'dawn',
  },
  {
    id: 'rush-hour', number: 2, name: 'Rush Hour', mood: 'Bright midday, busy chatter',
    teaches: 'Holding', lengthSeconds: 240, seed: 2202,
    aircraftMix: { regional: 60, light: 25, freighter: 15 }, unlocks: { hold: true, altitude: false },
    scripted: [{ at: 60, type: 'rushWave', params: { count: 5 } }, { at: 140, type: 'rushWave', params: { count: 6 } }, { at: 205, type: 'rushWave', params: { count: 7 } }],
    randomPool: [], threeStar: { landings: 25 }, palette: 'day',
  },
  {
    id: 'squall-line', number: 3, name: 'Squall Line', mood: 'Dark clouds rolling in',
    teaches: 'Altitude, heavy jets', lengthSeconds: 240, seed: 3303,
    aircraftMix: { regional: 45, light: 15, freighter: 20, heavy: 20 }, unlocks: { hold: true, altitude: true },
    scripted: [{ at: 45, type: 'storm' }, { at: 110, type: 'rushWave', params: { count: 6 } }, { at: 150, type: 'storm' }],
    randomPool: ['rushWave'], randomEverySeconds: [40, 60], threeStar: { landings: 25, maxStrikes: 1 }, palette: 'storm',
  },
  {
    id: 'monsoon-night', number: 4, name: 'Monsoon Night', mood: 'Night palette, rain over the radar',
    teaches: 'Helicopters, diversions', lengthSeconds: 240, seed: 4404,
    aircraftMix: { regional: 35, light: 10, freighter: 15, heavy: 20, heli: 20 }, unlocks: { hold: true, altitude: true },
    scripted: [{ at: 40, type: 'storm' }, { at: 80, type: 'radarBlackout' }, { at: 125, type: 'microburst' }, { at: 165, type: 'runwayIncursion' }, { at: 200, type: 'radarBlackout' }],
    randomPool: ['storm', 'microburst'], randomEverySeconds: [35, 55], threeStar: { landings: 22 }, palette: 'night',
  },
  {
    id: 'mayday-mayday', number: 5, name: 'Mayday Mayday', mood: 'Red-tinged, alarm-heavy',
    teaches: 'Emergencies', lengthSeconds: 240, seed: 5505,
    aircraftMix: { regional: 35, light: 10, freighter: 15, heavy: 20, heli: 10, medevac: 10 }, unlocks: { hold: true, altitude: true },
    scripted: [{ at: 40, type: 'engineFailure' }, { at: 75, type: 'birdStrike' }, { at: 110, type: 'engineFailure' }, { at: 150, type: 'birdStrike' }, { at: 185, type: 'engineFailure' }, { at: 215, type: 'engineFailure' }],
    randomPool: ['rushWave'], randomEverySeconds: [45, 60], threeStar: { allMaydaysSaved: true }, palette: 'alarm',
  },
  {
    id: 'red-corridor', number: 6, name: 'Red Corridor', mood: 'Cold, military, tense silence',
    teaches: 'Clearing airspace on command', lengthSeconds: 240, seed: 6606,
    aircraftMix: { regional: 35, light: 10, freighter: 15, heavy: 20, heli: 15, medevac: 5 }, unlocks: { hold: true, altitude: true },
    scripted: [{ at: 45, type: 'militaryCorridor' }, { at: 85, type: 'noRadio' }, { at: 120, type: 'militaryCorridor' }, { at: 150, type: 'storm' }, { at: 185, type: 'militaryCorridor' }, { at: 215, type: 'noRadio' }],
    randomPool: ['noRadio'], randomEverySeconds: [40, 60], threeStar: { landings: 20 }, palette: 'military',
  },
  {
    id: 'ash-sky', number: 7, name: 'Ash Sky', mood: 'Grey sky turning red',
    teaches: 'Everything at once', lengthSeconds: 300, seed: 7707,
    aircraftMix: { regional: 30, light: 15, freighter: 20, heavy: 20, heli: 10, medevac: 5 }, unlocks: { hold: true, altitude: true },
    scripted: [
      { at: 35, type: 'storm' }, { at: 70, type: 'engineFailure' }, { at: 100, type: 'radarBlackout' },
      { at: 135, type: 'militaryCorridor' }, { at: 170, type: 'microburst' }, { at: 205, type: 'birdStrike' },
      { at: 240, type: 'ashCloud', params: { coverFraction: 0.5 } },
      { at: 250, type: 'rushWave', params: { count: 10, fromClearSide: true } },
    ],
    randomPool: ['storm', 'engineFailure', 'noRadio'], randomEverySeconds: [30, 45],
    threeStar: { survive: true }, palette: 'ash',
  },
  {
    id: 'overnight', number: 'endless', name: 'Overnight', mood: 'Night, endless',
    teaches: 'Mastery', lengthSeconds: null, seed: 9909,
    aircraftMix: { regional: 30, light: 15, freighter: 20, heavy: 20, heli: 10, medevac: 5 }, unlocks: { hold: true, altitude: true },
    scripted: [],
    randomPool: ['storm', 'rushWave', 'microburst', 'radarBlackout', 'engineFailure', 'birdStrike', 'noRadio', 'militaryCorridor', 'runwayIncursion'],
    randomEverySeconds: [30, 45], threeStar: {}, palette: 'night',
  },
];

// ─────────────────────────────────────────────────────────────
// 6. VISUAL TOKENS
// ─────────────────────────────────────────────────────────────

export const COLORS = {
  bg: '#070B12',
  bgPanel: '#0C1420',
  grid: 'rgba(18,50,74,0.4)',
  ring: 'rgba(63,224,255,0.10)',
  glow: '#3FE0FF',
  text: '#E6F4FF',
  textDim: '#7E93A8',
  warning: '#FFB020',
  critical: '#FF3B4A',
  success: '#3DFFA0',
  storm: '#FF5A3D',
  ash: '#9AA3AD',
};

export const PALETTE_TINTS: Record<Shift['palette'], { bg: string; accent: string }> = {
  dawn:     { bg: '#08101C', accent: '#7CC4FF' },
  day:      { bg: '#09121D', accent: '#3FE0FF' },
  storm:    { bg: '#070B12', accent: '#3FE0FF' },
  night:    { bg: '#04070C', accent: '#2FB8D6' },
  alarm:    { bg: '#0D0709', accent: '#FF6B6B' },
  military: { bg: '#060A0A', accent: '#7FFFD4' },
  ash:      { bg: '#0B0B0C', accent: '#FF8A3D' },
};

export const FONTS = { mono: "'IBM Plex Mono', monospace", ui: "'Inter', system-ui, sans-serif" };
export const SWEEP_PERIOD_SECONDS = 4;
export const BLIP_TRAIL_DOTS = 5;
export const RANGE_RING_SPACING = 250;

// ─────────────────────────────────────────────────────────────
// 7. AUDIO (Web Audio synthesis recipes — no audio files)
// ─────────────────────────────────────────────────────────────

export const SOUNDS = {
  landing:      { type: 'two-note chime', notes: [659, 988], durMs: 140, wave: 'sine' },
  handoffSent:  { type: 'filtered noise whoosh', durMs: 300, filterFromHz: 800, filterToHz: 3000 },
  incoming:     { type: 'radio click', durMs: 40 },
  warning:      { type: 'two-tone alarm', notes: [880, 660], durMs: 180, repeatMs: 500, wave: 'square', gain: 0.15 },
  strike:       { type: 'low boom', freqFromHz: 120, freqToHz: 40, durMs: 600 },
  mayday:       { type: 'klaxon', freqHz: 440, pulses: 3, pulseMs: 250, wave: 'sawtooth', gain: 0.18 },
  thunder:      { type: 'lowpassed noise rumble', durMs: 1800 },
  static:       { type: 'bandpassed noise crackle', durMs: 'loop' },
  corridorRoar: { type: 'rising noise + saw', durMs: 6000 },
  skyCleared:   { type: 'swelling major chord', notes: [523, 659, 784, 1047], durMs: 2000 },
  ambientDrone: { type: 'low hum', baseHz: 55, rises: 'with plane count' },
};

export const HAPTICS = { // navigator.vibrate patterns (Android only; ignore elsewhere)
  landing: [15], incoming: [15, 60, 15], warning: [40], strike: [300], mayday: [80, 60, 80, 60, 80], skyCleared: [30, 50, 30, 50, 120],
};

// ─────────────────────────────────────────────────────────────
// 8. COPY (exact on-screen text)
// ─────────────────────────────────────────────────────────────

export const COPY = {
  tagline: 'One sky. Split screens. Nobody lands alone.',
  tutorial: [
    { title: 'Draw to land', body: 'Drag from a plane to the airport with the same colour and shape. Enter through the glowing cone.' },
    { title: 'Hand off', body: "Plane bound for a friend's airport? Draw it to the border. It crosses onto their screen. Now it's theirs." },
    { title: "Don't let them touch", body: 'Too close glows amber. Touching costs a strike. So does running out of fuel. Three strikes ends the shift.' },
  ],
  callouts: { incoming: 'INCOMING', hold: 'HOLD', clear: 'CLEAR', help: 'HELP' },
  banners: {
    incoming: 'INCOMING · {callsign} · from {player}',
    strike: 'LOSS OF SEPARATION',
    fuelOut: 'FUEL EXHAUSTED',
    mayday: 'MAYDAY · {callsign}',
    radarDegrading: 'RADAR DEGRADING',
    corridor: 'MILITARY CORRIDOR · CLEAR IN {s}',
    rush: 'INBOUND WAVE · {s}',
    skyCleared: 'SKY CLEARED',
    shiftOver: 'SHIFT OVER',
  },
  awards: {
    ironNerves: { title: 'Iron Nerves', rule: 'Most landings while any event was active' },
    handoffKing: { title: 'Handoff King', rule: 'Most smooth handoffs given' },
    theWall: { title: 'The Wall', rule: 'Zero strikes in your sector' },
  },
};
