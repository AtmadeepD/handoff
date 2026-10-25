/**
 * HANDOFF — in-shift client view (M2).
 * Renders the server's world; never decides outcomes. Positions are interpolated
 * between snapshots with a CLIENT_INTERP_BUFFER_MS delay so motion stays smooth.
 */
import type { Socket } from 'socket.io-client';
import {
  AIRPORT_STYLES, CLIENT_INTERP_BUFFER_MS, COLORS, COPY, LOW_FUEL_WARNING, MAX_PATH_POINTS,
  RANGE_RING_SPACING, SKY_RADIUS, SWEEP_PERIOD_SECONDS, type AircraftType,
} from '../shared/HANDOFF_DATA';
import { inApproachCone, runwayEnd, threshold, type Airport, type Vec } from '../shared/engine';

type PlaneInfo = { id: string; cs: string; t: AircraftType; d: string; mf: number; path: Vec[]; pv: number; ll: boolean };
type PlaneState = { id: string; x: number; y: number; h: number; f: number; pv: number; pr: number };
export type Snapshot = { tick: number; serverTime: number; elapsed: number; length: number | null; score: number; landings: number; strikesUsed: number; strikesAllowed: number; planes: PlaneState[] };
export type FullSync = { shift: { id: string; name: string; number: number | 'endless'; lengthSeconds: number | null }; players: number; airports: Airport[]; planes: PlaneInfo[]; snapshot: Snapshot };
export type ShiftResult = { score: number; landings: number; lost: number; strikesUsed: number; strikesAllowed: number; elapsed: number; reason: 'timer' | 'strikes' };
type Fx = { kind: 'landed' | 'lost'; x: number; y: number; born: number; points?: number; color: string };
type Pending = { planeId: string; seq: number; points: Vec[]; rejectedAt?: number };

const TOUCH_PICK_PX = 34;
const SAMPLE_PX = 6;

export class GameView {
  private root: HTMLDivElement;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private staticLayer = document.createElement('canvas');
  private hud: HTMLDivElement;
  private overlay: HTMLDivElement;
  private raf = 0;
  private w = 0; private h = 0; private dpr = 1;
  private cx = 0; private cy = 0; private scale = 1;

  private airports: Airport[] = [];
  private info = new Map<string, PlaneInfo>();
  private snaps: Snapshot[] = [];
  private offset: number | null = null; // serverTime - Date.now()
  private trails = new Map<string, { pts: Vec[]; last: number }>();
  private fx: Fx[] = [];
  private shiftName = '';
  private result: ShiftResult | null = null;

  private drawing: { planeId: string; points: Vec[]; screen: Vec[] } | null = null;
  private pending: Pending | null = null;
  private seq = 0;
  private hintDone = false;

  constructor(private mount: HTMLElement, private socket: Socket, private opts: { isHost: () => boolean; onLeave: () => void }) {
    this.root = document.createElement('div');
    this.root.className = 'game-root';
    this.root.innerHTML = `
      <canvas class="game-canvas" aria-label="Radar. Drag from a plane to its matching airport."></canvas>
      <div class="game-hud"></div>
      <div class="game-hint">${COPY.tutorial[0].body}</div>
      <div class="game-overlay hidden"></div>`;
    mount.replaceChildren(this.root);
    this.canvas = this.root.querySelector('canvas')!;
    this.ctx = this.canvas.getContext('2d')!;
    this.hud = this.root.querySelector('.game-hud')!;
    this.overlay = this.root.querySelector('.game-overlay')!;
    document.body.classList.add('in-game');
    this.bindInput();
    window.addEventListener('resize', this.onResize);
    this.onResize();
    this.raf = requestAnimationFrame(this.frame);
    // ?debug=1 exposes the view for automated play-tests and the M5 tuning panel
    if (new URLSearchParams(location.search).get('debug') === '1') (window as unknown as { __handoff?: unknown }).__handoff = this;
  }

  /** Debug helper: current interpolated planes in screen coordinates. */
  debugPlanes() {
    return [...this.interpolated()].map(([id, p]) => ({ id, dest: this.info.get(id)?.d, screen: this.toScreen(p), world: { x: p.x, y: p.y } }));
  }
  /** Debug helper: a screen point inside an airport's approach cone, 80 units out. */
  debugConePoint(airportId: string) {
    const a = this.airports.find(x => x.id === airportId); if (!a) return null;
    const t = threshold(a), back = ((a.runwayHeading + 180) * Math.PI) / 180;
    return this.toScreen({ x: t.x + Math.sin(back) * 80, y: t.y - Math.cos(back) * 80 });
  }

  destroy() {
    cancelAnimationFrame(this.raf);
    window.removeEventListener('resize', this.onResize);
    document.body.classList.remove('in-game');
    this.root.remove();
  }

  // ─── network inputs ──────────────────────────────────────────────

  full(sync: FullSync) {
    this.shiftName = sync.shift.name;
    this.airports = sync.airports;
    this.info = new Map(sync.planes.map(p => [p.id, p]));
    this.snaps = [];
    this.trails.clear();
    this.result = null;
    this.overlay.classList.add('hidden');
    this.snapshot(sync.snapshot);
    this.buildStatic();
  }

  snapshot(s: Snapshot) {
    const off = s.serverTime - Date.now();
    // keep the smallest observed offset (least network delay), drifting slowly toward new samples
    this.offset = this.offset === null ? off : Math.min(off, this.offset * 0.98 + off * 0.02);
    this.snaps.push(s);
    if (this.snaps.length > 40) this.snaps.shift();
    const live = new Set(s.planes.map(p => p.id));
    for (const id of [...this.info.keys()]) if (!live.has(id) && !this.recentlySpawned(id)) { this.info.delete(id); this.trails.delete(id); }
    this.renderHud(s);
  }

  private spawnedAt = new Map<string, number>();
  private recentlySpawned(id: string) { const t = this.spawnedAt.get(id); return t !== undefined && Date.now() - t < 1500; }
  spawned(p: PlaneInfo) { this.info.set(p.id, p); this.spawnedAt.set(p.id, Date.now()); }

  pathSet(e: { planeId: string; path: Vec[]; pv: number; ll: boolean; seq: number; by: string }, myId: string) {
    const p = this.info.get(e.planeId);
    if (p) { p.path = e.path; p.pv = e.pv; p.ll = e.ll; }
    if (this.pending && this.pending.planeId === e.planeId && (e.by !== myId || e.seq === this.pending.seq)) this.pending = null;
  }

  pathRejected(e: { planeId: string; seq: number }) {
    if (this.pending && this.pending.seq === e.seq) this.pending.rejectedAt = performance.now();
  }

  effect(e: { kind: 'landed' | 'lost'; x: number; y: number; points?: number; airportId?: string }) {
    const color = e.kind === 'landed' ? COLORS.success : COLORS.critical;
    const at = e.kind === 'landed' && e.airportId ? this.airports.find(a => a.id === e.airportId)?.position ?? e : e;
    this.fx.push({ kind: e.kind, x: at.x, y: at.y, born: performance.now(), points: e.points, color });
    if (e.kind === 'lost') { this.root.classList.remove('flash'); void this.root.offsetWidth; this.root.classList.add('flash'); }
  }

  over(r: ShiftResult) {
    this.result = r;
    const cleared = r.reason === 'timer';
    const host = this.opts.isHost();
    this.overlay.innerHTML = `
      <div class="over-card">
        <p class="eyebrow">${cleared ? COPY.banners.skyCleared : COPY.banners.shiftOver}</p>
        <h2>${cleared ? 'Shift survived' : 'Three strikes'}</h2>
        <div class="over-stats">
          <div><span>SCORE</span><b>${r.score}</b></div>
          <div><span>LANDINGS</span><b>${r.landings}</b></div>
          <div><span>LOST</span><b>${r.lost}</b></div>
          <div><span>STRIKES</span><b>${r.strikesUsed}/${r.strikesAllowed}</b></div>
        </div>
        ${host ? `<button class="primary" data-act="again">PLAY AGAIN <span>↻</span></button><button class="secondary" data-act="lobby">BACK TO LOBBY</button>`
               : `<p class="setting-note">Waiting for the host to start the next shift…</p>`}
      </div>`;
    this.overlay.classList.remove('hidden');
    this.overlay.querySelector('[data-act="again"]')?.addEventListener('click', () => this.socket.emit('start_shift'));
    this.overlay.querySelector('[data-act="lobby"]')?.addEventListener('click', () => this.socket.emit('return_to_lobby'));
  }

  // ─── HUD ─────────────────────────────────────────────────────────

  private renderHud(s: Snapshot) {
    const remaining = s.length === null ? s.elapsed : Math.max(0, s.length - s.elapsed);
    const mm = Math.floor(remaining / 60), ss = Math.floor(remaining % 60);
    const lamps = Array.from({ length: s.strikesAllowed }, (_, i) => `<i class="lamp ${i < s.strikesUsed ? 'hit' : ''}"></i>`).join('');
    this.hud.innerHTML = `
      <div class="hud-left"><div class="lamps">${lamps}</div><span class="hud-shift">${escapeHtml(this.shiftName.toUpperCase())}</span></div>
      <div class="hud-right"><b class="hud-timer">${mm}:${String(ss).padStart(2, '0')}</b></div>
      <div class="hud-score">SCORE <b>${s.score}</b> <span>· ${s.landings} LANDED</span></div>
      <button class="hud-leave" aria-label="Leave to lobby">✕</button>`;
    this.hud.querySelector('.hud-leave')!.addEventListener('click', () => this.opts.onLeave());
  }

  // ─── geometry ────────────────────────────────────────────────────

  private onResize = () => {
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.w = this.root.clientWidth || window.innerWidth;
    this.h = this.root.clientHeight || window.innerHeight;
    this.canvas.width = Math.round(this.w * this.dpr);
    this.canvas.height = Math.round(this.h * this.dpr);
    const top = 96, bottom = 40;
    const avail = Math.max(120, Math.min(this.w - 16, this.h - top - bottom));
    this.scale = avail / 2 / (SKY_RADIUS * 1.02);
    this.cx = this.w / 2;
    this.cy = top + (this.h - top - bottom) / 2;
    this.buildStatic();
  };
  private toScreen = (p: Vec): Vec => ({ x: this.cx + p.x * this.scale, y: this.cy + p.y * this.scale });
  private toWorld = (p: Vec): Vec => ({ x: (p.x - this.cx) / this.scale, y: (p.y - this.cy) / this.scale });

  // ─── interpolation ───────────────────────────────────────────────

  private interpolated(): Map<string, PlaneState> {
    const out = new Map<string, PlaneState>();
    if (!this.snaps.length || this.offset === null) return out;
    const renderAt = Date.now() + this.offset - CLIENT_INTERP_BUFFER_MS;
    let a = this.snaps[0], b = this.snaps[this.snaps.length - 1];
    for (let i = this.snaps.length - 1; i > 0; i--) {
      if (this.snaps[i - 1].serverTime <= renderAt) { a = this.snaps[i - 1]; b = this.snaps[i]; break; }
    }
    const span = Math.max(1, b.serverTime - a.serverTime);
    const t = Math.max(0, Math.min(1.5, (renderAt - a.serverTime) / span)); // small extrapolation if late
    const prev = new Map(a.planes.map(p => [p.id, p]));
    for (const pb of b.planes) {
      const pa = prev.get(pb.id) ?? pb;
      const dh = ((pb.h - pa.h + 540) % 360) - 180;
      out.set(pb.id, { ...pb, x: pa.x + (pb.x - pa.x) * t, y: pa.y + (pb.y - pa.y) * t, h: (pa.h + dh * Math.min(1, t) + 360) % 360, f: pa.f + (pb.f - pa.f) * t });
    }
    return out;
  }

  // ─── input: drag from a plane ────────────────────────────────────

  private bindInput() {
    const c = this.canvas;
    c.addEventListener('pointerdown', e => {
      if (this.result) return;
      const pt = this.local(e);
      let best: { id: string; d: number } | null = null;
      for (const [id, p] of this.interpolated()) {
        const s = this.toScreen(p);
        const d = Math.hypot(s.x - pt.x, s.y - pt.y);
        if (d < TOUCH_PICK_PX && (!best || d < best.d)) best = { id, d };
      }
      if (!best) return;
      e.preventDefault();
      c.setPointerCapture(e.pointerId);
      const p = this.interpolated().get(best.id)!;
      this.drawing = { planeId: best.id, points: [{ x: p.x, y: p.y }], screen: [this.toScreen(p)] };
    });
    c.addEventListener('pointermove', e => {
      if (!this.drawing) return;
      const pt = this.local(e);
      const last = this.drawing.screen[this.drawing.screen.length - 1];
      if (Math.hypot(pt.x - last.x, pt.y - last.y) < SAMPLE_PX) return;
      this.drawing.screen.push(pt);
      this.drawing.points.push(this.toWorld(pt));
    });
    const finish = () => {
      const d = this.drawing; this.drawing = null;
      if (!d || d.points.length < 2) return;
      const pts = simplify(d.points, 3 / this.scale, MAX_PATH_POINTS - 2).slice(1);
      if (!pts.length) return;
      this.seq++;
      this.pending = { planeId: d.planeId, seq: this.seq, points: [d.points[0], ...pts] };
      this.socket.emit('draw_path', { planeId: d.planeId, points: pts, seq: this.seq });
      if (!this.hintDone) { this.hintDone = true; this.root.querySelector('.game-hint')?.classList.add('gone'); }
    };
    c.addEventListener('pointerup', finish);
    c.addEventListener('pointercancel', () => { this.drawing = null; });
  }
  private local(e: PointerEvent): Vec { const r = this.canvas.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; }

  // ─── rendering ───────────────────────────────────────────────────

  private buildStatic() {
    const L = this.staticLayer;
    L.width = this.canvas.width; L.height = this.canvas.height;
    const g = L.getContext('2d')!;
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    g.clearRect(0, 0, this.w, this.h);
    const R = SKY_RADIUS * this.scale;
    // sky disc
    const grad = g.createRadialGradient(this.cx, this.cy, 0, this.cx, this.cy, R);
    grad.addColorStop(0, '#0B1826'); grad.addColorStop(1, '#070D16');
    g.fillStyle = grad; g.beginPath(); g.arc(this.cx, this.cy, R, 0, Math.PI * 2); g.fill();
    // range rings
    g.strokeStyle = 'rgba(63,224,255,0.09)'; g.lineWidth = 1;
    for (let r = RANGE_RING_SPACING; r < SKY_RADIUS; r += RANGE_RING_SPACING) { g.beginPath(); g.arc(this.cx, this.cy, r * this.scale, 0, Math.PI * 2); g.stroke(); }
    // rim + compass ticks
    g.strokeStyle = 'rgba(63,224,255,0.35)'; g.setLineDash([2, 6]); g.beginPath(); g.arc(this.cx, this.cy, R, 0, Math.PI * 2); g.stroke(); g.setLineDash([]);
    for (let i = 0; i < 72; i++) {
      const a = (i * 5 * Math.PI) / 180, long = i % 6 === 0;
      g.strokeStyle = long ? 'rgba(63,224,255,0.4)' : 'rgba(63,224,255,0.15)';
      g.beginPath(); g.moveTo(this.cx + Math.sin(a) * R, this.cy - Math.cos(a) * R); g.lineTo(this.cx + Math.sin(a) * (R - (long ? 10 : 5)), this.cy - Math.cos(a) * (R - (long ? 10 : 5))); g.stroke();
    }
    // airports: cone, runway, badge
    for (const a of this.airports) this.drawAirport(g, a, false);
  }

  private drawAirport(g: CanvasRenderingContext2D, a: Airport, lit: boolean) {
    const style = AIRPORT_STYLES[a.styleIndex];
    const t = this.toScreen(threshold(a)), e = this.toScreen(runwayEnd(a));
    // approach cone
    const back = ((a.runwayHeading + 180) * Math.PI) / 180;
    const len = 120 * this.scale, half = (15 * Math.PI) / 180;
    const p1 = { x: t.x + Math.sin(back - half) * len, y: t.y - Math.cos(back - half) * len };
    const p2 = { x: t.x + Math.sin(back + half) * len, y: t.y - Math.cos(back + half) * len };
    const cg = g.createLinearGradient(t.x, t.y, (p1.x + p2.x) / 2, (p1.y + p2.y) / 2);
    cg.addColorStop(0, hexA(style.color, lit ? 0.75 : 0.42)); cg.addColorStop(1, hexA(style.color, 0));
    g.fillStyle = cg; g.beginPath(); g.moveTo(t.x, t.y); g.lineTo(p1.x, p1.y); g.lineTo(p2.x, p2.y); g.closePath(); g.fill();
    // runway
    g.lineCap = 'round';
    g.strokeStyle = hexA(style.color, 0.9); g.lineWidth = Math.max(4, 10 * this.scale);
    g.beginPath(); g.moveTo(t.x, t.y); g.lineTo(e.x, e.y); g.stroke();
    g.strokeStyle = '#070B12'; g.lineWidth = 1; g.setLineDash([3, 3]); g.beginPath(); g.moveTo(t.x, t.y); g.lineTo(e.x, e.y); g.stroke(); g.setLineDash([]);
    // badge
    const c = this.toScreen(a.position);
    const bx = c.x + 18, by = c.y + 14;
    g.fillStyle = '#0C1420'; g.strokeStyle = style.color; g.lineWidth = 1.5;
    g.beginPath(); g.arc(bx, by, 11, 0, Math.PI * 2); g.fill(); g.stroke();
    drawShape(g, style.shape, bx, by, 5.5, style.color);
  }

  private frame = (now: number) => {
    this.raf = requestAnimationFrame(this.frame);
    const g = this.ctx;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.fillStyle = COLORS.bg; g.fillRect(0, 0, this.canvas.width, this.canvas.height);
    g.drawImage(this.staticLayer, 0, 0);
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);

    const planes = this.interpolated();
    this.drawSweep(g, now);

    // highlight the airport the current drawing would land at
    if (this.drawing) {
      const info = this.info.get(this.drawing.planeId);
      const end = this.drawing.points[this.drawing.points.length - 1];
      const dest = info && this.airports.find(a => a.id === info.d);
      if (dest && inApproachCone(end, dest)) this.drawAirport(g, dest, true);
    }

    // paths
    const dash = -(now / 40) % 26;
    for (const [id, p] of planes) {
      const info = this.info.get(id); if (!info || !info.path.length) continue;
      const remaining = p.pv === info.pv ? info.path.slice(Math.max(0, info.path.length - p.pr)) : info.path;
      if (!remaining.length) continue;
      const color = AIRPORT_STYLES[this.styleOf(info.d)].color;
      g.strokeStyle = hexA(color, info.ll ? 0.95 : 0.7); g.lineWidth = info.ll ? 2.4 : 2;
      g.setLineDash([8, 5]); g.lineDashOffset = dash;
      g.beginPath(); const s0 = this.toScreen(p); g.moveTo(s0.x, s0.y);
      for (const q of remaining) { const s = this.toScreen(q); g.lineTo(s.x, s.y); }
      g.stroke(); g.setLineDash([]);
    }
    // pending (sent, awaiting server) and in-progress drawing
    if (this.pending) {
      const rej = this.pending.rejectedAt !== undefined;
      if (rej && performance.now() - this.pending.rejectedAt! > 500) this.pending = null;
      else this.strokePath(g, this.pending.points, rej ? COLORS.critical : 'rgba(230,244,255,0.55)', [4, 6]);
    }
    if (this.drawing) {
      const info = this.info.get(this.drawing.planeId);
      const color = info ? AIRPORT_STYLES[this.styleOf(info.d)].color : COLORS.text;
      this.strokePath(g, this.drawing.points, color, [6, 5]);
    }

    // planes
    for (const [id, p] of planes) {
      const info = this.info.get(id); if (!info) continue;
      const s = this.toScreen(p);
      this.drawTrail(g, id, s, now);
      const low = p.f / info.mf <= LOW_FUEL_WARNING;
      const blink = low && Math.floor(now / 300) % 2 === 0;
      const body = low ? COLORS.warning : COLORS.text;
      const size = info.t === 'heavy' ? 1.35 : info.t === 'light' ? 0.85 : 1;
      if (this.drawing?.planeId === id) { g.strokeStyle = hexA(COLORS.glow, 0.8); g.lineWidth = 1.5; g.beginPath(); g.arc(s.x, s.y, 16, 0, Math.PI * 2); g.stroke(); }
      g.save(); g.translate(s.x, s.y); g.rotate((p.h * Math.PI) / 180); g.scale(size, size);
      g.fillStyle = body; g.beginPath(); g.moveTo(0, -9); g.lineTo(7, 7); g.lineTo(0, 3); g.lineTo(-7, 7); g.closePath(); g.fill();
      g.restore();
      // data block: callsign + destination badge + fuel bar
      const style = AIRPORT_STYLES[this.styleOf(info.d)];
      g.font = '600 11px "IBM Plex Mono", ui-monospace, monospace';
      const tw = g.measureText(info.cs).width, fw = 40, blockW = Math.max(tw + 14, fw);
      const bx = s.x + 12 + blockW > this.w - 6 ? s.x - 12 - blockW : s.x + 12; // keep the label on screen
      const by = s.y - 8 < 18 ? s.y + 22 : s.y - 8;
      g.fillStyle = blink ? COLORS.warning : COLORS.text;
      g.fillText(info.cs, bx, by);
      drawShape(g, style.shape, bx + tw + 8, by - 4, 4.5, style.color);
      g.fillStyle = 'rgba(42,58,76,0.9)'; g.fillRect(bx, by + 5, fw, 3);
      g.fillStyle = low ? COLORS.warning : COLORS.success; g.fillRect(bx, by + 5, fw * Math.max(0, p.f / info.mf), 3);
    }

    // effects
    this.fx = this.fx.filter(f => now - f.born < 1100);
    for (const f of this.fx) {
      const k = (now - f.born) / 1100, s = this.toScreen(f);
      g.strokeStyle = hexA(f.color, 1 - k); g.lineWidth = 2;
      g.beginPath(); g.arc(s.x, s.y, 10 + k * 46, 0, Math.PI * 2); g.stroke();
      if (f.kind === 'landed' && f.points) { g.fillStyle = hexA(COLORS.success, 1 - k); g.font = '700 14px "IBM Plex Mono", ui-monospace, monospace'; g.fillText(`+${f.points}`, s.x - 10, s.y - 22 - k * 20); }
    }
  };

  private strokePath(g: CanvasRenderingContext2D, pts: Vec[], color: string, dash: number[]) {
    if (pts.length < 2) return;
    g.strokeStyle = color; g.lineWidth = 2; g.setLineDash(dash);
    g.beginPath(); pts.forEach((q, i) => { const s = this.toScreen(q); i ? g.lineTo(s.x, s.y) : g.moveTo(s.x, s.y); }); g.stroke(); g.setLineDash([]);
  }

  private drawSweep(g: CanvasRenderingContext2D, now: number) {
    const ang = ((now / 1000) % SWEEP_PERIOD_SECONDS) / SWEEP_PERIOD_SECONDS * Math.PI * 2;
    const R = SKY_RADIUS * this.scale;
    for (let i = 0; i < 8; i++) {
      const a0 = ang - (i + 1) * 0.06, a1 = ang - i * 0.06;
      g.fillStyle = `rgba(63,224,255,${0.06 * (1 - i / 8)})`;
      g.beginPath(); g.moveTo(this.cx, this.cy); g.arc(this.cx, this.cy, R, a0 - Math.PI / 2, a1 - Math.PI / 2); g.closePath(); g.fill();
    }
    g.strokeStyle = 'rgba(63,224,255,0.5)'; g.lineWidth = 1.2;
    g.beginPath(); g.moveTo(this.cx, this.cy); g.lineTo(this.cx + Math.sin(ang) * R, this.cy - Math.cos(ang) * R); g.stroke();
  }

  private drawTrail(g: CanvasRenderingContext2D, id: string, s: Vec, now: number) {
    let tr = this.trails.get(id);
    if (!tr) { tr = { pts: [], last: 0 }; this.trails.set(id, tr); }
    if (now - tr.last > 350) { tr.pts.unshift(s); tr.pts = tr.pts.slice(0, 5); tr.last = now; }
    tr.pts.forEach((q, i) => { if (!i) return; g.fillStyle = `rgba(63,224,255,${0.45 - i * 0.08})`; g.beginPath(); g.arc(q.x, q.y, 1.8, 0, Math.PI * 2); g.fill(); });
  }

  private styleOf(airportId: string) { return this.airports.find(a => a.id === airportId)?.styleIndex ?? 0; }
}

// ─── helpers ───────────────────────────────────────────────────────

function hexA(hex: string, a: number) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}
function escapeHtml(s: string) { return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!)); }

export function drawShape(g: CanvasRenderingContext2D, shape: string, x: number, y: number, r: number, color: string) {
  g.fillStyle = color; g.beginPath();
  switch (shape) {
    case 'triangle': g.moveTo(x, y - r); g.lineTo(x + r, y + r * 0.8); g.lineTo(x - r, y + r * 0.8); break;
    case 'circle': g.arc(x, y, r, 0, Math.PI * 2); break;
    case 'square': g.rect(x - r * 0.85, y - r * 0.85, r * 1.7, r * 1.7); break;
    case 'diamond': g.moveTo(x, y - r); g.lineTo(x + r, y); g.lineTo(x, y + r); g.lineTo(x - r, y); break;
    case 'pentagon': for (let i = 0; i < 5; i++) { const a = -Math.PI / 2 + (i * 2 * Math.PI) / 5; i ? g.lineTo(x + Math.cos(a) * r, y + Math.sin(a) * r) : g.moveTo(x + Math.cos(a) * r, y + Math.sin(a) * r); } break;
    case 'cross': { const k = r * 0.38; g.rect(x - k, y - r, 2 * k, 2 * r); g.rect(x - r, y - k, 2 * r, 2 * k); break; }
  }
  g.closePath(); g.fill();
}

/** Ramer–Douglas–Peucker simplification, loosened until it fits in `max` points. */
export function simplify(points: Vec[], epsilon: number, max: number): Vec[] {
  const rdp = (pts: Vec[], eps: number): Vec[] => {
    if (pts.length < 3) return pts;
    const a = pts[0], b = pts[pts.length - 1];
    let idx = 0, dmax = 0;
    for (let i = 1; i < pts.length - 1; i++) {
      const d = segDist(pts[i], a, b);
      if (d > dmax) { dmax = d; idx = i; }
    }
    if (dmax <= eps) return [a, b];
    return [...rdp(pts.slice(0, idx + 1), eps).slice(0, -1), ...rdp(pts.slice(idx), eps)];
  };
  let eps = epsilon, out = rdp(points, eps);
  while (out.length > max) { eps *= 1.6; out = rdp(points, eps); }
  return out;
}
function segDist(p: Vec, a: Vec, b: Vec) {
  const dx = b.x - a.x, dy = b.y - a.y, L = dx * dx + dy * dy;
  if (!L) return Math.hypot(p.x - a.x, p.y - a.y);
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / L));
  return Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy);
}

