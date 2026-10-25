import { io, Socket } from 'socket.io-client';
import QRCode from 'qrcode';
import { COLORS, AIRPORT_STYLES, SHIFTS, DIFFICULTY } from '../shared/HANDOFF_DATA';
import './style.css';
import { GameView, type FullSync, type ShiftResult, type Snapshot } from './game';

type PublicRoom = { code: string; hostId: string; phase: 'lobby' | 'shift' | 'over'; players: { id: string; nickname: string; seat: number; color: string; connected: boolean }[]; settings: { shift: number; difficulty: keyof typeof DIFFICULTY }; maxPlayers: number };
type Reply = { room: PublicRoom; reconnectToken: string; playerId: string };
const app = document.querySelector<HTMLDivElement>('#app')!;
const socket: Socket = io({ autoConnect: true, transports: ['websocket', 'polling'] });
let nickname = sessionStorage.getItem('handoff.nickname') || '';
let reconnectToken = sessionStorage.getItem('handoff.reconnectToken') || '';
let myPlayerId = sessionStorage.getItem('handoff.playerId') || '';
let room: PublicRoom | null = null;
let errorMessage = '';
let statusMessage = '';
let joinCode = new URLSearchParams(location.search).get('room')?.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4) || '';

function esc(s: string) { return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!)); }
function saveNickname() { nickname = (document.querySelector<HTMLInputElement>('#nickname')?.value || '').trim().replace(/\s+/g, ' ').slice(0, 18); sessionStorage.setItem('handoff.nickname', nickname); return nickname; }
function renderHome() {
  room = null;
  app.innerHTML = `<main class="shell home"><div class="ambient" aria-hidden="true"></div><header class="brand"><div class="brand-mark">H<span>·</span></div><div><p class="eyebrow">CO-OPERATIVE AIR TRAFFIC CONTROL</p><h1>HANDOFF</h1><p class="tagline">One sky. Split screens. Nobody lands alone.</p></div></header><section class="radar-card"><canvas id="hero-radar" aria-hidden="true"></canvas><div class="radar-label"><span class="live-dot"></span> NETWORK STANDBY <span>·</span> 6 SECTORS</div></section><section class="entry-panel"><label for="nickname">CONTROLLER CALLSIGN</label><input id="nickname" maxlength="18" autocomplete="nickname" placeholder="Enter your name" value="${esc(nickname)}"/><div class="actions"><button id="create" class="primary">CREATE ROOM <span>↗</span></button><button id="show-join" class="secondary">JOIN ROOM</button></div><div id="join-form" class="join-form ${joinCode ? 'open' : ''}"><label for="room-code">ROOM CODE</label><input id="room-code" class="code-input" maxlength="4" autocapitalize="characters" autocomplete="off" placeholder="ABCD" value="${esc(joinCode)}"/><button id="join" class="primary full">JOIN THE SKY ↗</button></div><p class="microcopy">NO ACCOUNT. NO INSTALL. JUST YOUR CREW.</p></section><footer><span>HANDOFF // PUBLIC TEST BUILD</span><span>SERVER-AUTHORITATIVE · LIVE SYNC</span></footer>${errorMessage ? `<p class="error-banner">${esc(errorMessage)}</p>` : ''}</main>`;
  drawRadar('hero-radar');
  document.querySelector<HTMLButtonElement>('#create')!.onclick = () => { if (!saveNickname()) return showError('Enter a nickname first.'); errorMessage = ''; socket.emit('create_room', { nickname }); };
  document.querySelector<HTMLButtonElement>('#show-join')!.onclick = () => { document.querySelector('#join-form')?.classList.toggle('open'); document.querySelector<HTMLInputElement>('#room-code')?.focus(); };
  const codeInput = document.querySelector<HTMLInputElement>('#room-code');
  codeInput?.addEventListener('input', () => { codeInput.value = codeInput.value.toUpperCase().replace(/[^A-Z]/g, '').replace(/[IOL]/g, '').slice(0, 4); joinCode = codeInput.value; });
  document.querySelector<HTMLButtonElement>('#join')!.onclick = () => { if (!saveNickname()) return showError('Enter a nickname first.'); const code = codeInput?.value.trim().toUpperCase() || ''; if (code.length !== 4 || /[IOL]/.test(code)) return showError('Use a valid 4-letter room code.'); errorMessage = ''; socket.emit('join_room', { code, nickname, reconnectToken: reconnectToken && sessionStorage.getItem('handoff.room') === code ? reconnectToken : undefined }); };
}
function renderLobby() {
  if (!room) return;
  const isHost = myPlayerId === room.hostId;
  const shiftOptions = SHIFTS.map(s => `<option value="${s.number === 'endless' ? 8 : s.number}" ${room!.settings.shift === (s.number === 'endless' ? 8 : s.number) ? 'selected' : ''}>${s.number === 'endless' ? '∞' : String(s.number).padStart(2, '0')} — ${esc(s.name)}${s.number === 1 ? ' · START HERE' : ''}</option>`).join('');
  const playerSlots = Array.from({ length: room.maxPlayers }, (_, i) => { const p = room!.players.find(x => x.seat === i); return p ? `<div class="player-chip"><span class="seat-dot" style="--seat:${p.color}"></span><span class="player-name">${esc(p.nickname)}${p.id === room!.hostId ? '<small>HOST</small>' : ''}</span><span class="connection ${p.connected ? 'on' : ''}"></span></div>` : `<div class="player-chip empty"><span class="seat-dot"></span><span>AWAITING CONTROLLER</span><span class="seat-number">0${i + 1}</span></div>`; }).join('');
  app.innerHTML = `<main class="shell lobby"><header class="topbar"><button class="wordmark" id="home">H<span>·</span> HANDOFF</button><span class="pill"><i></i> ROOM ACTIVE</span></header><section class="room-code-panel"><p class="eyebrow">YOUR ROOM CODE</p><div class="room-code" aria-label="Room code ${room.code}">${room.code.split('').map((c,i)=>`<span style="--i:${i}">${c}</span>`).join('')}</div><p class="subline">SHARE THE CODE OR SCAN TO JOIN</p><div class="qr-wrap"><canvas id="room-qr"></canvas><div><strong>BRING YOUR CREW</strong><p>Scan to open this room on another phone.</p><button id="copy-link" class="text-button">COPY INVITE LINK ↗</button></div></div></section><section class="crew-panel"><div class="section-heading"><div><p class="eyebrow">THE CREW</p><h2>Controllers <span>${room.players.length}<i>/</i>${room.maxPlayers}</span></h2></div><span class="sync-label"><b></b> SYNCED</span></div><div class="player-list">${playerSlots}</div></section><section class="mission-panel"><div class="section-heading"><div><p class="eyebrow">NEXT ASSIGNMENT</p><h2>Shift briefing</h2></div><span class="host-tag">${isHost ? 'HOST CONTROLS' : 'HOST SELECTS'}</span></div><div class="settings-grid"><div><label for="shift">SHIFT</label><select id="shift" ${isHost ? '' : 'disabled'}>${shiftOptions}</select><p class="setting-note">${esc(SHIFTS.find(s => (s.number === 'endless' ? 8 : s.number) === room!.settings.shift)?.teaches || '')}</p></div><div><label for="difficulty">DIFFICULTY</label><select id="difficulty" ${isHost ? '' : 'disabled'}>${Object.entries(DIFFICULTY).map(([k,v])=>`<option value="${k}" ${room!.settings.difficulty===k?'selected':''}>${k.toUpperCase()} · ${v.strikes} STRIKES</option>`).join('')}</select><p class="setting-note">Shared team rules. One sky, one outcome.</p></div></div></section><section class="lobby-bottom"><div><span class="ready-indicator"></span><span>${room.players.length === 1 ? 'PRACTICE MODE READY' : 'CREW LINK ESTABLISHED'}</span><p>${isHost ? (room.players.length === 1 ? 'Solo practice: you control the whole sky.' : 'Everyone controls the whole sky in this build.') : 'Waiting for the host to start the shift.'}</p></div><button class="primary" id="ready" ${isHost ? "" : "disabled"}>${isHost ? 'START SHIFT' : 'HOST STARTS'} <span>↗</span></button></section><footer><span>HANDOFF // M2 CORE</span><span>NO ACCOUNTS · NO INSTALLS</span></footer>${errorMessage ? `<p class="error-banner">${esc(errorMessage)}</p>` : ''}${statusMessage ? `<p class="toast">${esc(statusMessage)}</p>` : ''}</main>`;
  const qrCanvas = document.querySelector<HTMLCanvasElement>('#room-qr')!;
  const invite = `${location.origin}${location.pathname}?room=${room.code}`;
  QRCode.toCanvas(qrCanvas, invite, { width: 128, margin: 1, color: { dark: '#070B12', light: '#E6F4FF' } }).catch(() => {});
  document.querySelector<HTMLButtonElement>('#home')!.onclick = () => { socket.emit('leave_room'); sessionStorage.removeItem('handoff.room'); renderHome(); };
  document.querySelector<HTMLButtonElement>('#copy-link')!.onclick = async () => { try { await navigator.clipboard.writeText(invite); statusMessage = 'Invite link copied.'; renderLobby(); } catch { statusMessage = invite; renderLobby(); } };
  document.querySelector<HTMLSelectElement>('#shift')!.onchange = e => socket.emit('set_settings', { shift: Number((e.target as HTMLSelectElement).value) });
  document.querySelector<HTMLSelectElement>('#difficulty')!.onchange = e => socket.emit('set_settings', { difficulty: (e.target as HTMLSelectElement).value });
  document.querySelector<HTMLButtonElement>('#ready')!.onclick = () => socket.emit('start_shift');
}
function showError(message: string) { errorMessage = message; if (game) return; if (room) renderLobby(); else renderHome(); }

// ─── screen routing: the server's room phase decides which screen is shown ───
let game: GameView | null = null;
let pendingSync: FullSync | null = null;
function ensureGame(): GameView {
  if (!game) game = new GameView(app, socket, { isHost: () => !!room && room.hostId === myPlayerId, onLeave: leaveToHome });
  return game;
}
function closeGame() { game?.destroy(); game = null; }
function leaveToHome() { closeGame(); socket.emit('leave_room'); sessionStorage.removeItem('handoff.room'); room = null; renderHome(); }
function route() {
  if (!room) { closeGame(); return; }
  if (room.phase === 'lobby') { closeGame(); renderLobby(); return; }
  const view = ensureGame();
  if (pendingSync) { view.full(pendingSync); pendingSync = null; }
}

function drawRadar(id: string) {
  const canvas = document.getElementById(id) as HTMLCanvasElement | null; if (!canvas) return;
  const ctx = canvas.getContext('2d'); if (!ctx) return;
  const rect = canvas.getBoundingClientRect(); const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.max(1, rect.width * dpr); canvas.height = Math.max(1, rect.height * dpr); ctx.scale(dpr,dpr);
  const w = rect.width, h = rect.height, cx = w*.5, cy = h*.56, r = Math.min(w*.47,h*.88);
  ctx.clearRect(0,0,w,h); ctx.strokeStyle = 'rgba(18,50,74,.65)'; ctx.lineWidth = 1;
  for(let i=1;i<=4;i++){ctx.beginPath();ctx.arc(cx,cy,r*i/4,0,Math.PI*2);ctx.stroke();}
  for(let i=0;i<12;i++){const a=i*Math.PI/6;ctx.beginPath();ctx.moveTo(cx,cy);ctx.lineTo(cx+Math.cos(a)*r,cy+Math.sin(a)*r);ctx.stroke();}
  ctx.strokeStyle=COLORS.glow;ctx.globalAlpha=.22;ctx.beginPath();ctx.moveTo(cx,cy);ctx.arc(cx,cy,r,-.5,-.5+Math.PI*.7);ctx.closePath();ctx.fillStyle=COLORS.glow;ctx.fill();ctx.globalAlpha=1;ctx.beginPath();ctx.moveTo(cx,cy);ctx.lineTo(cx+Math.cos(-.5)*r,cy+Math.sin(-.5)*r);ctx.stroke();
  for(let i=0;i<7;i++){const a=i*2.4+.4, rr=r*(.25+(i%3)*.2), x=cx+Math.cos(a)*rr,y=cy+Math.sin(a)*rr;const dot=i%2?COLORS.success:COLORS.glow;ctx.fillStyle=dot;ctx.shadowColor=dot;ctx.shadowBlur=8;ctx.fillRect(x-2,y-2,4,4);ctx.shadowBlur=0;}
}
socket.on('room_created', (reply: Reply) => acceptRoom(reply));
socket.on('room_joined', (reply: Reply) => acceptRoom(reply));
socket.on('lobby_state', (next: PublicRoom) => { if (room?.code !== next.code) return; room = next; if (next.phase === 'lobby') route(); else if (!game) socket.emit('request_sync'); });
socket.on('room_error', (e: { message?: string }) => showError(e.message || 'Something went wrong. Try again.'));
socket.on('room_closed', (e: { message?: string }) => { room = null; sessionStorage.removeItem('handoff.room'); sessionStorage.removeItem('handoff.reconnectToken'); sessionStorage.removeItem('handoff.playerId'); showError(e.message || 'Room closed.'); });
socket.on('connect', () => { if (reconnectToken && sessionStorage.getItem('handoff.room')) socket.emit('join_room', { code: sessionStorage.getItem('handoff.room'), nickname: nickname || 'Controller', reconnectToken }); });
function acceptRoom(reply: Reply) { room = reply.room; reconnectToken = reply.reconnectToken; myPlayerId = reply.playerId; sessionStorage.setItem('handoff.reconnectToken', reconnectToken); sessionStorage.setItem('handoff.playerId', myPlayerId); sessionStorage.setItem('handoff.room', room.code); errorMessage = ''; statusMessage = ''; { const q = new URLSearchParams(location.search); q.set('room', room.code); history.replaceState({}, '', `${location.pathname}?${q}`); } route(); }
socket.on('shift_started', (sync: FullSync) => { if (!room) return; room.phase = 'shift'; pendingSync = sync; route(); });
socket.on('snapshot', (s: Snapshot) => game?.snapshot(s));
socket.on('plane_spawned', (p: Parameters<GameView['spawned']>[0]) => game?.spawned(p));
socket.on('path_set', (e: Parameters<GameView['pathSet']>[0]) => game?.pathSet(e, myPlayerId));
socket.on('path_rejected', (e: Parameters<GameView['pathRejected']>[0]) => game?.pathRejected(e));
socket.on('fx', (e: Parameters<GameView['effect']>[0]) => game?.effect(e));
socket.on('shift_over', (r: ShiftResult) => { if (room) room.phase = 'over'; ensureGame().over(r); });
renderHome();
window.addEventListener('resize', () => { if (!room) drawRadar('hero-radar'); });
