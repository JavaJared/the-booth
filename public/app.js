import { OFFENSE, DEFENSE, OFF_BY_ID, DEF_BY_ID } from './shared/playbook.js';
import { newGameState, emptyTendencies, fieldGoalProb, readTendencies, distBucket } from './shared/engine.js';
import { callRecord, opponentReport, shellReport, selfScout, unitSummary, isSuccess, boxScore } from './shared/scout.js';
import { makeRosters, matchupBoard, bySpot } from './shared/roster.js';
import { createSeason, advanceWeek, simRemainingWeek, userGame, record as seasonRecord,
  liveConfig, statsFromPlays, resume, weekLabel, weekGames, REGULAR_WEEKS,
  hydrate, dehydrate, startOffseason, recordInterview, interviewsLeft, canReady,
  useScout, pushSide, pushPlayer, signFreeAgent,
  setOffseasonReady, advanceOffseason, bothReady, nextSeason,
  interviewQuestions } from './shared/season.js';
import { resumeScore, archetypeOf } from './shared/carousel.js';
import { scoutView } from './shared/draft.js';
import { FORMATIONS, FIELD_W, derivePlay, validate, describeRoute,
  OL_SPOTS, runSpots, DEF_ALIGN, deriveRun, deriveDefense, readRun, readDefense } from './shared/designer.js';
import { registerCustomPlays, registerCustomDefenses } from './shared/playbook.js';
import { TEAMS, TEAM_BY_ID, DIVISIONS, fullName, sortedStandings } from './shared/league.js';
import { runToNextDecision, seatOnClock, keyRead, PLAY_CLOCK_MS, FILM_COST } from './shared/gameflow.js';

const API_URL = '/api';   // Netlify function; see netlify.toml

const $ = (id) => document.getElementById(id);
const el = (tag, cls, html) => { const n = document.createElement(tag); if (cls) n.className = cls; if (html != null) n.innerHTML = html; return n; };
const abbr = (s) => s.slice(0, 3).toUpperCase();

/**
 * An arrowhead, plus the point the line should stop at. Drawing the line all
 * the way to the tip leaves the stroke poking through the triangle instead of
 * ending in it, which is what made these look wrong.
 */
function arrow(from, to, len = 1.7, halfWidth = 0.8) {
  const dx = to[0] - from[0], dy = to[1] - from[1];
  const m = Math.hypot(dx, dy) || 1;
  const ux = dx / m, uy = dy / m;
  const base = [to[0] - ux * len, to[1] - uy * len];
  const px = -uy, py = ux;                      // perpendicular
  const pts = [to,
    [base[0] + px * halfWidth, base[1] + py * halfWidth],
    [base[0] - px * halfWidth, base[1] - py * halfWidth]];
  return { base, points: pts.map((p) => p.map((v) => +v.toFixed(2)).join(',')).join(' ') };
}
const mmss = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
const ORD = { 1: '1ST', 2: '2ND', 3: '3RD', 4: '4TH', 5: 'OT' };

/* ============================================================ transports
   Both expose the same surface, so the UI never knows which is running. */

class LocalTransport {
  constructor() { this.plays = []; this.listeners = []; this.local = true; }
  emit() { this.listeners.forEach((f) => f(this.game, this.plays)); }
  subscribe(f) { this.listeners.push(f); if (this.game) f(this.game, this.plays); }

  async create({ name, seat, teamName = 'Cascade', oppName = 'Ironworks', rosters, firstPossession, autoSeat }) {
    this.gameId = 'local-' + Math.random().toString(36).slice(2, 8);
    this.game = {
      id: this.gameId, status: 'live', teamName, oppName,
      rosterSeed: Math.random().toString(36).slice(2, 12),
      rosters,
      autoSeat: autoSeat || null,
      seats: { OC: { displayName: 'Offense', ready: true }, DC: { displayName: 'Defense', ready: true } },
      state: newGameState({ firstPossession: firstPossession || (Math.random() < 0.5 ? 'US' : 'CPU') }),
      tendencies: { US: emptyTendencies(), CPU: emptyTendencies() },
      gameplan: { OC: { aggression: 0, tempo: 'normal' }, DC: { aggression: 0, tempo: 'normal' } },
      filmPoints: { OC: 0, DC: 0 }, pending: {}, pause: { state: 'none' }, chirps: [],
    };
    this.mySeat = seat;
    this.emit();
    // If the AI coordinator's unit is on the clock first, let it play until
    // the human is actually needed.
    if (this.game.autoSeat && seatOnClock(this.game.state) === this.game.autoSeat) {
      await this.call({ auto: true });
    }
    return { gameId: this.gameId, seat };
  }
  async call({ callId, special, auto }) {
    const r = runToNextDecision(this.gameId, this.game, { callId, special, auto });
    this.plays.push(...r.plays);
    Object.assign(this.game, {
      state: r.state, tendencies: r.tendencies, filmPoints: r.filmPoints,
      status: r.state.status === 'final' ? 'final' : 'live', pending: {},
    });
    this.emit();
  }
  async predict(guess, seat) {
    this.game.pending.prediction = { seat, guess, playIndex: this.game.state.playIndex };
    this.emit();
  }
  async plan(seat, plan) { this.game.gameplan[seat] = plan; this.emit(); }
  async keys(seat) {
    if ((this.game.filmPoints[seat] || 0) < FILM_COST) throw new Error('Not enough film points.');
    this.game.filmPoints[seat] -= FILM_COST;
    this.game.pending.hint = { seat, playIndex: this.game.state.playIndex, text: keyRead(this.gameId, this.game) };
    this.emit();
  }
  async ready() {}
  async pause() { this.game.status = this.game.status === 'paused' ? 'live' : 'paused'; this.emit(); }
  async respond() {}
  async chirp(text, seat) {
    this.game.chirps = [...this.game.chirps, { seat, text, at: Date.now() }].slice(-8);
    this.emit();
  }
}

class FirebaseTransport {
  constructor(fb) { Object.assign(this, fb); this.plays = []; this.listeners = []; this.local = false; }
  subscribe(f) { this.listeners.push(f); if (this.game) f(this.game, this.plays); }
  emit() { this.listeners.forEach((f) => f(this.game, this.plays)); }

  watch(gameId) {
    this.gameId = gameId;
    const { onSnapshot, doc, collection, query, orderBy, db } = this;
    onSnapshot(doc(db, 'games', gameId), (s) => { this.game = s.data(); this.emit(); });
    onSnapshot(query(collection(db, 'games', gameId, 'plays'), orderBy('playIndex')), (s) => {
      this.plays = s.docs.map((d) => d.data()); this.emit();
    });
  }
  async create(opts) { const r = await this.fn('createGame')(opts); this.mySeat = r.data.seat; this.watch(r.data.gameId); return r.data; }
  async join(gameId, displayName) { const r = await this.fn('joinGame')({ gameId, displayName }); this.mySeat = r.data.seat; this.watch(gameId); return r.data; }
  async ready(ready) { return this.fn('setReady')({ gameId: this.gameId, ready }); }
  async call({ callId, special }) {
    return this.fn('submitCall')({ gameId: this.gameId, playIndex: this.game.state.playIndex, callId, special });
  }
  async predict(guess) { return this.fn('submitPrediction')({ gameId: this.gameId, playIndex: this.game.state.playIndex, guess }); }
  async plan(_seat, plan) { return this.fn('setGameplan')({ gameId: this.gameId, plan }); }
  async keys() { return this.fn('readKeys')({ gameId: this.gameId }); }
  async pause(reason) { return this.fn('proposePause')({ gameId: this.gameId, reason }); }
  async respond(accept) { return this.fn('respondPause')({ gameId: this.gameId, accept }); }
  async chirp(text) { return this.fn('chirp')({ gameId: this.gameId, text }); }
}

/* ============================================================ call sheet */

const OFF_GROUPS = [
  { title: 'Run game', has: (p) => p.family === 'run' },
  { title: 'Quick & screen', has: (p) => p.family === 'quick' || p.family === 'screen' },
  { title: 'Dropback', has: (p) => p.family === 'dropback' },
  { title: 'Shots & play action', has: (p) => p.family === 'shot' || p.family === 'playaction' },
];
const DEF_GROUPS = [
  { title: 'Zone', ids: ['base3', 'nick3', 'cloud3', 'nick2', 'tampa', 'cover6'] },
  { title: 'Man', ids: ['nick1', 'bear1', 'simpress'] },
  { title: 'Pressure', ids: ['firezone', 'nickblitz', 'agap', 'cover0', 'dime0', 'runblitz'] },
  { title: 'Situational', ids: ['quarters', 'base4', 'dime4', 'prevent', 'goalline'] },
];
const GUESS_OFF = [['run', 'Run'], ['quick', 'Quick game'], ['screen', 'Screen'],
  ['dropback', 'Dropback'], ['playaction', 'Play action'], ['shot', 'Deep shot']];
const GUESS_DEF = [['man', 'Man'], ['zone', 'Zone'], ['blitz', 'Blitz']];
const CHIRPS = ['Nice call.', 'That is on you.', 'Get me the ball back.', 'Take the points.',
  'We need a stop.', 'Stop stat-padding.'];

/* ============================================================ app */

const app = {
  t: null, seat: 'OC', name: '', viewSeat: null, picked: null, busy: false, tick: null,
};

/* ---------- setup ---------- */
document.querySelectorAll('.seat-btn').forEach((b) => b.addEventListener('click', () => {
  document.querySelectorAll('.seat-btn').forEach((x) => { x.classList.remove('is-on'); x.setAttribute('aria-checked', 'false'); });
  b.classList.add('is-on'); b.setAttribute('aria-checked', 'true');
  app.seat = b.dataset.seat;
}));

const setupErr = (m) => { $('setup-err').textContent = m || ''; };
const nameVal = () => ($('name').value.trim() || 'Coordinator');

$('btn-local').addEventListener('click', async () => {
  app.name = nameVal();
  app.t = new LocalTransport();
  await app.t.create({ name: app.name, seat: app.seat });
  app.t.subscribe(render);
  show('game');
});

$('btn-create').addEventListener('click', async () => {
  setupErr('');
  try {
    const fb = await connectFirebase();
    app.name = nameVal();
    app.t = new FirebaseTransport(fb);
    const made = await app.t.create({ seat: app.seat, displayName: app.name });
    rememberGame(made.gameId, app.name);
    app.t.subscribe(render);
    show('lobby');
  } catch (e) { setupErr(e.message); }
});

$('btn-join').addEventListener('click', async () => {
  setupErr('');
  const code = $('join-code').value.trim();
  if (!code) return setupErr('Enter the game code your rival sent you.');
  try {
    const fb = await connectFirebase();
    app.name = nameVal();
    // One box for both kinds of invitation — try a season, fall back to a game.
    try {
      const r = await fb.fn('joinSeason')({ seasonId: code, displayName: app.name });
      rememberSeasonCode(code);
      watchSeason(fb, code, r.data.seat);
      return;
    } catch (seasonErr) {
      if (!/No season with that code/i.test(seasonErr.message)) throw seasonErr;
    }
    app.t = new FirebaseTransport(fb);
    await app.t.join(code, app.name);
    rememberGame(code, app.name);
    app.t.subscribe(render);
    show('lobby');
  } catch (e) { setupErr(e.message.replace(/^.*?: /, '')); }
});

$('btn-ready').addEventListener('click', () => app.t.ready(true));

async function connectFirebase() {
  let cfg;
  try { cfg = (await import('./firebase-config.js')).firebaseConfig; }
  catch { throw new Error('Add your keys to firebase-config.js, or use both seats on this device.'); }

  const [{ initializeApp }, auth, fs] = await Promise.all([
    import('https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js'),
    import('https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js'),
    import('https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js'),
  ]);
  const fbApp = initializeApp(cfg);
  const a = auth.getAuth(fbApp);
  await auth.signInAnonymously(a);

  // Reads come straight from Firestore (realtime, and the rules make them
  // read-only). Every write goes through the serverless API, which is the only
  // thing holding admin credentials.
  const call = async (action, data) => {
    const token = await a.currentUser.getIdToken();
    const res = await fetch(API_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ action, data }),
    });
    const body = await res.json().catch(() => ({ error: 'Server did not respond.' }));
    if (!res.ok) throw new Error(body.error || `Request failed (${res.status}).`);
    return body;
  };

  return {
    db: fs.getFirestore(fbApp),
    onSnapshot: fs.onSnapshot, doc: fs.doc, collection: fs.collection,
    query: fs.query, orderBy: fs.orderBy,
    fn: (name) => (data) => call(name, data),
  };
}

function show(id) {
  ['setup', 'lobby', 'season', 'designer', 'game'].forEach((s) => { $(s).hidden = s !== id; });
}

/* ============================================================ play designer
   A coordinator does not label a play; the routes decide what it is. The read
   panel updates as you draw, so you can see a concept form. */

const DZ = { mode: 'pass', pers: '11', sel: null, routes: {}, pa: false,
  carrier: [], carrierSpot: 'RB1', blocks: {}, blockers: [], dpos: {}, paths: {}, man: false };
const DZ_W = 60, DZ_H = 46, DZ_LOS = 34;          // viewBox units
const fx = (x) => 3 + (x / FIELD_W) * (DZ_W - 6);  // field x -> svg x
const fy = (y) => DZ_LOS - y * 0.95;               // yards downfield -> svg y
const ux = (px) => ((px - 3) / (DZ_W - 6)) * FIELD_W;
const uy = (py) => (DZ_LOS - py) / 0.95;

/** Coordinators install their own side of the ball, and only their own. */
function designerModes() {
  return app.seat === 'DC'
    ? [['def', 'Defensive call']]
    : [['pass', 'Pass concept'], ['run', 'Run play']];
}

function openDesigner() {
  const modes = designerModes();
  if (!modes.some(([k]) => k === DZ.mode)) DZ.mode = modes[0][0];
  $('dz-modes').innerHTML = modes.map(([k, l]) =>
    `<button class="tab${k === DZ.mode ? ' is-on' : ''}" data-mode="${k}">${l}</button>`).join('');
  $('dz-modes').querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => {
    DZ.mode = t.dataset.mode;
    DZ.sel = null; DZ.routes = {}; DZ.carrier = []; DZ.carrierSpot = 'RB1';
    DZ.blocks = {}; DZ.blockers = []; DZ.paths = {};
    openDesigner();
  }));
  $('dz-pers').closest('.dz-controls').querySelectorAll('.dz-check')
    .forEach((c) => { c.hidden = DZ.mode !== 'pass'; });
  // Personnel groupings are an offensive idea; the defence has no use for them.
  $('dz-pers').closest('.form-field').hidden = DZ.mode === 'def';
  $('dz-hint').textContent = {
    pass: 'Pick a receiver, then click downfield to draw his route. Click him again to keep him in to block.',
    run: 'The circled player has the ball. Draw his path, then send everyone else to a block. Click a back or receiver twice to hand him the ball instead.',
    def: 'Pick a defender, then draw where he goes. Across the line is a blitz; anywhere behind it is his zone.',
  }[DZ.mode];
  const sel = $('dz-pers');
  sel.innerHTML = Object.entries(FORMATIONS)
    .map(([k, v]) => `<option value="${k}">${k} personnel &mdash; ${v.label}</option>`).join('');
  sel.value = DZ.pers;
  show('designer');
  drawDesigner();
}

function drawDesigner() {
  if (DZ.mode === 'def') return drawDefense();
  const base = FORMATIONS[DZ.pers].spots;
  const spots = DZ.mode === 'run' ? runSpots(DZ.pers) : base;
  const p = [];
  p.push(`<svg viewBox="0 0 ${DZ_W} ${DZ_H}" class="dz-field" xmlns="http://www.w3.org/2000/svg">`);
  for (let y = -5; y <= 30; y += 5) {
    p.push(`<line x1="2" y1="${fy(y)}" x2="${DZ_W - 2}" y2="${fy(y)}" class="${y === 0 ? 'dz-los' : 'dz-grid'}"/>`);
    if (y > 0) p.push(`<text x="${DZ_W - 2.5}" y="${fy(y) + 0.5}" class="dz-yard">${y}</text>`);
  }

  // In run mode everyone owns their own path; only the designated carrier
  // writes to DZ.carrier. Treating every skill player as the ball carrier
  // meant drawing for a receiver silently edited whoever went before him.
  const paths = DZ.mode === 'run'
    ? { ...DZ.blocks, ...(DZ.carrier.length > 1 ? { [DZ.carrierSpot]: DZ.carrier } : {}) }
    : DZ.routes;
  for (const [spot, pos] of Object.entries(spots)) {
    const pts = paths[spot];
    if (pts && pts.length > 1) {
      const on = DZ.sel === spot ? ' on' : '';
      const svgPts = pts.map((q) => [fx(q[0]), fy(q[1])]);
      const tip = svgPts[svgPts.length - 1];
      const prev = svgPts[svgPts.length - 2];
      const { base, points } = arrow(prev, tip, 1.7, 0.8);
      // Stop the stroke at the base so the route actually ends in the triangle.
      const line = [...svgPts.slice(0, -1), base];
      const d = line.map((q, i) => `${i ? 'L' : 'M'} ${q[0].toFixed(2)} ${q[1].toFixed(2)}`).join(' ');
      p.push(`<path d="${d}" class="dz-route${on}"/>`);
      p.push(`<polygon points="${points}" class="dz-arrow${on}"/>`);
    }
  }
  for (const [spot, pos] of Object.entries(spots)) {
    const carrying = DZ.mode === 'run' && spot === DZ.carrierSpot;
    const blocking = DZ.mode === 'pass' && DZ.blockers.includes(spot);
    // Role decides the fill; selection is a ring on top. Letting selection own
    // the fill hid whether a player was carrying or blocking.
    const cls = ['dz-spot',
      carrying ? 'dz-carrier' : blocking ? 'dz-block' : (paths[spot]?.length > 1 ? 'has' : ''),
      DZ.sel === spot ? 'on' : ''].filter(Boolean).join(' ');
    p.push(`<circle cx="${fx(pos[0])}" cy="${fy(pos[1])}" r="1.5" class="${cls}" data-spot="${spot}"/>`);
    if (blocking) p.push(`<line x1="${fx(pos[0]) - 1.6}" y1="${fy(pos[1]) - 2.2}" x2="${fx(pos[0]) + 1.6}" y2="${fy(pos[1]) - 2.2}" class="dz-blockbar"/>`);
    if (carrying) p.push(`<circle cx="${fx(pos[0])}" cy="${fy(pos[1])}" r="2.4" class="dz-ball"/>`);
    p.push(`<text x="${fx(pos[0])}" y="${fy(pos[1]) + 3.6}" class="dz-label">${spot}</text>`);
  }
  p.push('</svg>');
  $('dz-field').innerHTML = p.join('');

  const svg = $('dz-field').querySelector('svg');
  // null means "this is the ball carrier"; anything else is its own bucket.
  const store = (spot) => {
    if (DZ.mode !== 'run') return DZ.routes;
    return spot === DZ.carrierSpot ? null : DZ.blocks;
  };
  svg.querySelectorAll('.dz-spot').forEach((c) => c.addEventListener('click', (e) => {
    e.stopPropagation();
    const spot = c.dataset.spot;
    if (DZ.mode === 'pass' && DZ.sel === spot && !(DZ.routes[spot]?.length > 1)) {
      // Selected, no route drawn, clicked again: he stays in to block.
      DZ.blockers = DZ.blockers.includes(spot)
        ? DZ.blockers.filter((x) => x !== spot) : [...DZ.blockers, spot];
      return drawDesigner();
    }
    if (DZ.mode === 'run' && DZ.sel === spot && !(spot in OL_SPOTS) && spot !== DZ.carrierSpot) {
      // Clicking a selected back or receiver again hands him the ball. Swap the
      // two players' paths so neither loses what was already drawn.
      const old = DZ.carrierSpot;
      const his = DZ.blocks[spot] || [spots[spot]];
      if (DZ.carrier.length > 1) DZ.blocks[old] = DZ.carrier; else delete DZ.blocks[old];
      delete DZ.blocks[spot];
      DZ.carrierSpot = spot;
      DZ.carrier = his;
      return drawDesigner();
    }
    DZ.sel = spot;
    if (DZ.mode === 'pass') DZ.blockers = DZ.blockers.filter((x) => x !== spot);
    const box = store(spot);
    if (box === null) { if (DZ.carrier.length < 1) DZ.carrier = [spots[spot]]; }
    else if (!box[spot]) box[spot] = [spots[spot]];
    drawDesigner();
  }));
  svg.addEventListener('click', (e) => {
    if (!DZ.sel) {
      $('dz-hint').textContent = DZ.mode === 'run'
        ? 'Pick the ball carrier or a lineman, then click where he goes.'
        : 'Pick a receiver first, then click where he goes.';
      return;
    }
    const r = svg.getBoundingClientRect();
    const pt = [+ux(((e.clientX - r.left) / r.width) * DZ_W).toFixed(1),
                +uy(((e.clientY - r.top) / r.height) * DZ_H).toFixed(1)];
    const box = store(DZ.sel);
    if (box === null) DZ.carrier = [...(DZ.carrier.length ? DZ.carrier : [spots[DZ.sel]]), pt];
    else box[DZ.sel] = [...(box[DZ.sel] || [spots[DZ.sel]]), pt];
    drawDesigner();
  });

  readDesigner();
}

/** Place defenders, mark the rushers, choose man or zone. The coverage names
    itself from how many are deep and how the backs are playing it. */
function drawDefense() {
  const pos = { ...DEF_ALIGN, ...DZ.dpos };
  const p = [];
  p.push(`<svg viewBox="0 0 ${DZ_W} ${DZ_H}" class="dz-field" xmlns="http://www.w3.org/2000/svg">`);
  for (let y = -5; y <= 30; y += 5) {
    p.push(`<line x1="2" y1="${fy(y)}" x2="${DZ_W - 2}" y2="${fy(y)}" class="${y === 0 ? 'dz-los' : 'dz-grid'}"/>`);
    if (y > 0) p.push(`<text x="${DZ_W - 2.5}" y="${fy(y) + 0.5}" class="dz-yard">${y}</text>`);
  }
  p.push(`<line x1="2" y1="${fy(10)}" x2="${DZ_W - 2}" y2="${fy(10)}" class="dz-deep"/>`);
  const read = readDefense(defDesign());
  const rushing = new Set(read.rushers);
  for (const [spot, pts] of Object.entries(DZ.paths)) {
    if (!pts || pts.length < 2) continue;
    const svgPts = pts.map((q) => [fx(q[0]), fy(q[1])]);
    const tip = svgPts[svgPts.length - 1], prev = svgPts[svgPts.length - 2];
    const { base, points } = arrow(prev, tip, 1.6, 0.75);
    const on = DZ.sel === spot ? ' on' : '';
    const kind = rushing.has(spot) ? ' dz-blitz' : ' dz-zone';
    const line = [...svgPts.slice(0, -1), base];
    p.push(`<path d="${line.map((q, i) => `${i ? 'L' : 'M'} ${q[0].toFixed(2)} ${q[1].toFixed(2)}`).join(' ')}" class="dz-route${kind}${on}"/>`);
    p.push(`<polygon points="${points}" class="dz-arrow${kind}${on}"/>`);
    if (!rushing.has(spot)) {
      // A zone drop finishes in an area, so show the landmark he is responsible for.
      p.push(`<circle cx="${tip[0]}" cy="${tip[1]}" r="2.6" class="dz-zonearea"/>`);
    }
  }
  for (const [spot, q] of Object.entries(pos)) {
    const cls = ['dz-spot',
      rushing.has(spot) ? 'dz-rusher' : DZ.paths[spot]?.length > 1 ? 'has' : '',
      DZ.sel === spot ? 'on' : ''].filter(Boolean).join(' ');
    p.push(`<circle cx="${fx(q[0])}" cy="${fy(q[1])}" r="1.5" class="${cls}" data-spot="${spot}"/>`);
    p.push(`<text x="${fx(q[0])}" y="${fy(q[1]) + 3.6}" class="dz-label">${spot}</text>`);
  }
  p.push('</svg>');
  $('dz-field').innerHTML = p.join('');

  const svg = $('dz-field').querySelector('svg');
  svg.querySelectorAll('.dz-spot').forEach((c) => c.addEventListener('click', (e) => {
    e.stopPropagation();
    const spot = c.dataset.spot;
    // Clicking a selected defender again wipes his assignment and lets you
    // redraw it, which is quicker than undoing point by point.
    if (DZ.sel === spot) delete DZ.paths[spot];
    else DZ.sel = spot;
    drawDesigner();
  }));
  svg.addEventListener('click', (e) => {
    if (!DZ.sel) { $('dz-hint').textContent = 'Pick a defender first, then draw where he goes.'; return; }
    const r = svg.getBoundingClientRect();
    const pt = [+ux(((e.clientX - r.left) / r.width) * DZ_W).toFixed(1),
                +uy(((e.clientY - r.top) / r.height) * DZ_H).toFixed(1)];
    const base = { ...DEF_ALIGN, ...DZ.dpos }[DZ.sel];
    DZ.paths[DZ.sel] = [...(DZ.paths[DZ.sel]?.length ? DZ.paths[DZ.sel] : [base]), pt];
    drawDesigner();
  });
  readDesigner();
}

/** Live read of the concept, so the geometry explains itself. */
function readDesigner() {
  if (DZ.mode === 'def') return readDefensePanel();
  if (DZ.mode === 'run') return readRunPanel();
  const design = {
    id: 'custom-' + Date.now(), name: $('dz-name').value,
    pers: DZ.pers, playAction: DZ.pa,
    assignments: Object.fromEntries(Object.entries(DZ.routes).filter(([, v]) => v.length > 1)),
    blockers: (DZ.blockers || []).length,
  };
  const box = $('dz-read');
  const routed = Object.keys(design.assignments).length;
  if (routed < 2) {
    box.innerHTML = `<p class="scout-note">Draw at least two routes and the concept will name itself.</p>`;
    return;
  }
  const play = derivePlay(design);
  const c = play.structure;
  const covs = [['man1', 'Man'], ['cover2', 'Cover 2'], ['tampa2', 'Tampa 2'],
    ['cover3', 'Cover 3'], ['quarters', 'Quarters']];
  const best = covs.reduce((a, b) => (play.vs[a[0]] > play.vs[b[0]] ? a : b));
  box.innerHTML = `<p class="dz-tag">${play.tag}</p>`
    + `<p class="scout-note" style="padding:0">Best against <b>${best[1]}</b>.</p>`
    + '<div class="dz-read"><h4>Structure</h4></div>'
    + table(['', ''], [
        ['Crossers', `${c.crossers}`],
        ['Rub / pick action', `${c.rubs}`],
        ['Vertical stretch', `${c.verticalStretch} level${c.verticalStretch === 1 ? '' : 's'}`],
        ['Deep routes', `${c.deep}`],
        ['Blockers kept in', `${c.blockers}`],
      ])
    + '<div class="dz-read"><h4>How it grades</h4></div>'
    + table(['', ''], [
        ['Completion', `${Math.round(play.comp * 100)}%`],
        ['Yards per catch', play.mean.toFixed(1)],
        ['Sack risk', `${(play.sack * 100).toFixed(1)}%`],
        ['Versus pressure', play.blitzFit > 0.5 ? 'good' : play.blitzFit > 0 ? 'fair' : 'poor'],
      ])
    + '<div class="dz-read"><h4>Coverage</h4></div>'
    + table(['', 'Edge'], covs.map(([k, l]) =>
        [l, `<span class="gap ${play.vs[k] > 0.03 ? 'good' : play.vs[k] < -0.03 ? 'bad' : ''}">${
          play.vs[k] > 0 ? '+' : ''}${play.vs[k].toFixed(2)}</span>`]));
  const bad = validate(design);
  if (bad.length) box.insertAdjacentHTML('beforeend', `<p class="dz-bad">${bad[0]}</p>`);
}

$('btn-designer').addEventListener('click', openDesigner);
$('btn-designer-solo').addEventListener('click', openDesigner);
function runDesign() {
  return { id: 'r' + Date.now(), name: $('dz-name').value, pers: DZ.pers,
    carrier: DZ.carrier, carrierSpot: DZ.carrierSpot, blocks: DZ.blocks };
}
function readRunPanel() {
  const box = $('dz-read');
  if (DZ.carrier.length < 2) {
    box.innerHTML = `<p class="scout-note">Draw where the ball carrier goes, then block it up.</p>`;
    return;
  }
  const play = deriveRun(runDesign());
  const r = play.structure;
  box.innerHTML = `<p class="dz-tag">${play.tag}</p>`
    + `<p class="scout-note" style="padding:0">Attacks ${play.edge === 'outside' ? 'the perimeter' : 'inside'}.</p>`
    + '<div class="dz-read"><h4>Structure</h4></div>'
    + table(['', ''], [
        ['Aiming point', r.edge === 'outside' ? 'outside the tackle' : 'between the tackles'],
        ['Pullers', `${r.pullers}`], ['Double teams', `${r.doubles}`],
        ['Down blocks', `${r.downBlocks}`], ['Misdirection', r.misdirection ? 'yes' : 'no'],
      ])
    + '<div class="dz-read"><h4>How it grades</h4></div>'
    + table(['', ''], [
        ['Yards per carry', play.mean.toFixed(1)],
        ['Stuffed', `${Math.round(play.stuff * 100)}%`],
        ['Versus a loaded box', play.boxFit > 1.05 ? 'suffers' : play.boxFit < 0.8 ? 'holds up' : 'neutral'],
      ]);
}

function defDesign() {
  return { id: 'd' + Date.now(), name: $('dz-name').value,
    positions: DZ.dpos, paths: DZ.paths, man: DZ.man };
}
const COV_LABEL = { man0: 'Cover 0', man1: 'Cover 1', cover2: 'Cover 2',
  tampa2: 'Tampa 2', cover3: 'Cover 3', quarters: 'Quarters', cover6: 'Cover 6' };
function readDefensePanel() {
  const call = deriveDefense(defDesign());
  const d = call.structure;
  $('dz-read').innerHTML = `<p class="dz-tag">${COV_LABEL[call.cov]}</p>`
    + `<p class="scout-note" style="padding:0">${call.tag || 'base look'}</p>`
    + `<label class="dz-check" style="margin:.6rem 0"><input type="checkbox" id="dz-man"${DZ.man ? ' checked' : ''}> Backs play man</label>`
    + '<div class="dz-read"><h4>Structure</h4></div>'
    + table(['', ''], [
        ['Deep defenders', `${d.deep}`], ['In the box', `${d.box}`],
        ['Rushers', `${d.rush}`], ['Press coverage', `${d.press}`],
      ])
    + '<div class="dz-read"><h4>How it grades</h4></div>'
    + table(['', ''], [
        ['Personnel', call.pers],
        ['Run commitment', call.runCommit > 0.15 ? 'heavy' : call.runCommit < -0.1 ? 'soft' : 'balanced'],
      ]);
  const cb = document.getElementById('dz-man');
  if (cb) cb.addEventListener('change', (e) => { DZ.man = e.target.checked; readDesigner(); });
}

$('dz-pers').addEventListener('change', (e) => { DZ.pers = e.target.value; DZ.routes = {}; DZ.sel = null; drawDesigner(); });
$('dz-pa').addEventListener('change', (e) => { DZ.pa = e.target.checked; readDesigner(); });
$('dz-name').addEventListener('input', readDesigner);
const activePaths = () => DZ.mode === 'def' ? DZ.paths
  : DZ.mode === 'run' ? (DZ.sel === DZ.carrierSpot ? null : DZ.blocks) : DZ.routes;
$('dz-undo').addEventListener('click', () => {
  const box = activePaths();
  if (box === null) { if (DZ.carrier.length > 1) DZ.carrier.pop(); }
  else if (DZ.sel && box[DZ.sel]?.length > 1) box[DZ.sel].pop();
  drawDesigner();
});
$('dz-clear').addEventListener('click', () => {
  const box = activePaths();
  if (box === null) DZ.carrier = [];
  else if (DZ.sel) delete box[DZ.sel];
  drawDesigner();
});
$('dz-close').addEventListener('click', () => { show(app.season ? 'season' : 'setup'); if (app.season) renderSeason(); });
$('dz-save').addEventListener('click', () => {
  if (DZ.mode === 'run') {
    const d = runDesign();
    if (!d.name.trim()) return flash('Give the play a name.');
    if (DZ.carrier.length < 2) return flash('Draw where the ball carrier goes.');
    const play = deriveRun({ ...d, id: 'cr' + Math.random().toString(36).slice(2, 8) });
    registerCustomPlays([play]);
    if (app.season) {
      app.season = { ...app.season, customPlays: [...(app.season.customPlays || []), play] };
      saveSeason();
    }
    DZ.carrier = []; DZ.blocks = {}; DZ.sel = null; DZ.carrierSpot = 'RB1';
    $('dz-name').value = '';
    flash(`${play.name} installed \u2014 ${play.tag}.`);
    return drawDesigner();
  }
  if (DZ.mode === 'def') {
    const d = defDesign();
    if (!d.name.trim()) return flash('Give the call a name.');
    const call = deriveDefense({ ...d, id: 'cd' + Math.random().toString(36).slice(2, 8) });
    registerCustomDefenses([call]);
    if (app.season) {
      app.season = { ...app.season, customDefenses: [...(app.season.customDefenses || []), call] };
      saveSeason();
    }
    $('dz-name').value = '';
    flash(`${call.name} installed \u2014 ${COV_LABEL[call.cov]}.`);
    return drawDesigner();
  }
  const design = {
    id: 'cp' + Math.random().toString(36).slice(2, 8), name: $('dz-name').value,
    pers: DZ.pers, playAction: DZ.pa,
    assignments: Object.fromEntries(Object.entries(DZ.routes).filter(([, v]) => v.length > 1)),
    blockers: (DZ.blockers || []).length,
  };
  const bad = validate(design);
  if (bad.length) return flash(bad[0]);
  const play = derivePlay(design);
  registerCustomPlays([play]);
  if (app.season) {
    app.season = { ...app.season, customPlays: [...(app.season.customPlays || []), play] };
    saveSeason();
  }
  DZ.routes = {}; DZ.sel = null;
  $('dz-name').value = '';
  flash(`${play.name} installed — ${play.tag}.`);
  drawDesigner();
});

/* ============================================================ season
   Local seasons live in this tab and survive a refresh. Losing seventeen
   weeks of work to an accidental reload would be unforgivable. */

const SAVE_KEY = 'booth:season';
const GAME_KEY = 'booth:game';

function rememberGame(gameId, name) {
  try { localStorage.setItem(GAME_KEY, JSON.stringify({ gameId, name, at: Date.now() })); } catch {}
}
function forgetGame() { try { localStorage.removeItem(GAME_KEY); } catch {} }

/** Offer to walk back into a two-player game after a reload. */
async function offerRejoin() {
  let saved;
  try { saved = JSON.parse(localStorage.getItem(GAME_KEY) || 'null'); } catch { return; }
  if (!saved?.gameId || Date.now() - saved.at > 1000 * 60 * 60 * 24 * 3) return forgetGame();
  modal(`<h2>Rejoin your game?</h2><p>You were in a game with a rival. Anonymous sign-in
    keeps your seat as long as it is the same browser.</p>
    <div class="modal-actions"><button class="btn btn-primary" data-a="yes">Rejoin</button>
    <button class="btn" data-a="no">Not now</button></div>`, async (act) => {
    closeModal();
    if (act !== 'yes') return forgetGame();
    try {
      const fb = await connectFirebase();
      app.name = saved.name || 'Coordinator';
      app.t = new FirebaseTransport(fb);
      await app.t.join(saved.gameId, app.name);
      app.t.subscribe(render);
      show('lobby');
    } catch (e) { setupErr(e.message); forgetGame(); }
  });
}
offerRejoin();

function saveSeason() {
  try { localStorage.setItem(SAVE_KEY, JSON.stringify({ season: app.season, seat: app.seat })); }
  catch (e) { /* private browsing or quota — the season still works in memory */ }
}
function loadSeason() {
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch { return null; }
}
export function clearSeason() { try { localStorage.removeItem(SAVE_KEY); } catch {} }

/* One interface over a season, whether it lives in this browser or in
   Firestore. Everything the week pane calls goes through here. */
/** Every server call goes through here, so a rejection surfaces instead of
    disappearing into an unhandled promise. */
function run(p) {
  return Promise.resolve(p).catch((e) => flash(e.message || 'That did not work.'));
}

const link = {
  local: true,
  async vote(choice) {
    if (this.local) {
      if (choice === 'sim') { app.season = simRemainingWeek(app.season); renderSeason(); }
      else {
        const g = userGame(app.season);
        if (g) startSeasonGame(liveConfig(app.season, g));
      }
      return;
    }
    await api('voteWeek', { seasonId: app.seasonId, choice });
  },
  async advance() {
    if (this.local) { app.season = advanceWeek(app.season); renderSeason(); return; }
    await api('advanceSeason', { seasonId: app.seasonId });
  },
  async finish() {
    if (this.local) return;
    await api('finishWeek', { seasonId: app.seasonId });
  },
  seats() { return this.local ? [app.seat] : ['OC', 'DC'].filter((s) => app.seasonDoc?.seats?.[s]); },
  async interview(teamId, choices) {
    if (this.local) {
      app.season = recordInterview(app.season, app.seat, teamId, choices);
      renderSeason();
      return;
    }
    await api('recordInterview', { seasonId: app.seasonId, teamId, choices });
  },
  async scoutLook(prospectId) {
    if (this.local) { app.season = useScout(app.season, app.seat, prospectId); renderSeason(); return; }
    await api('useScout', { seasonId: app.seasonId, prospectId });
  },
  async lobbySide() {
    if (this.local) { app.season = pushSide(app.season, app.seat, 1); renderSeason(); return; }
    await api('pushSide', { seasonId: app.seasonId, amount: 1 });
  },
  async lobbyPlayer(prospectId) {
    if (this.local) { app.season = pushPlayer(app.season, app.seat, prospectId); renderSeason(); return; }
    await api('pushPlayer', { seasonId: app.seasonId, prospectId });
  },
  async sign(faId) {
    if (this.local) { app.season = signFreeAgent(app.season, app.seat, faId); renderSeason(); return; }
    await api('signFreeAgent', { seasonId: app.seasonId, faId });
  },
  async ready(ready = true) {
    if (this.local) {
      let next = setOffseasonReady(app.season, app.seat, ready);
      if (bothReady(next, [app.seat])) next = advanceOffseason(next, [app.seat]);
      app.season = next;
      renderSeason();
      return;
    }
    await api('readyOffseason', { seasonId: app.seasonId, ready });
  },
};

let _fb = null;
async function api(action, data) {
  if (!_fb) _fb = await connectFirebase();
  return (await _fb.fn(action)(data)).data;
}

/** Follow a shared season, and the game inside it when one is running. */
function watchSeason(fb, seasonId, seat) {
  app.seasonId = seasonId;
  app.seat = seat;
  link.local = false;
  app.inSeason = true;
  let attached = null;
  fb.onSnapshot(fb.doc(fb.db, 'seasons', seasonId), (snap) => {
    const doc = snap.data();
    if (!doc) return;
    app.seasonDoc = doc;
    app.season = hydrate(JSON.parse(JSON.stringify(doc)));

    if (doc.currentGameId && attached !== doc.currentGameId) {
      attached = doc.currentGameId;
      const t = new FirebaseTransport(fb);
      t.mySeat = seat;
      app.t = t;
      app.liveCfg = null;
      t.watch(doc.currentGameId);
      t.subscribe(render);
      show('game');
      return;
    }
    if (!doc.currentGameId) {
      attached = null;
      app.t = null;
      show('season');
      renderSeason();
    }
  });
}

$('btn-season').addEventListener('click', () => {
  const saved = loadSeason();
  if (saved?.season) {
    modal(`<h2>Season in progress</h2><p>You are ${weekLabel(saved.season.week).toLowerCase()} with the
      ${fullName(saved.season.userTeam)}. Pick up where you left off?</p>
      <div class="modal-actions"><button class="btn btn-primary" data-a="resume">Resume</button>
      <button class="btn" data-a="new">Start fresh</button></div>`, (act) => {
      closeModal();
      if (act === 'resume') { app.season = saved.season; app.seat = saved.seat || 'OC'; openSeason(); }
      else { clearSeason(); pickTeam(); }
    });
    return;
  }
  pickTeam();
});

function pickTeam() {
  const opts = TEAMS.map((t) => `<option value="${t.id}">${t.city} ${t.name}</option>`).join('');
  modal(`<h2>Take the job</h2>
    <p>Pick the club you are joining. You and your rival share it — one calls offense, one calls defense.</p>
    <label class="form-field"><span>Club</span>
      <select id="team-pick" class="select">${opts}</select></label>
    <label class="form-field"><span>Who else is in the booth?</span>
      <select id="mode-pick" class="select">
        <option value="solo">Just me — an AI runs the other unit</option>
        <option value="rival">A rival, on their own device</option>
      </select></label>
    <div class="modal-actions">
      <button class="btn btn-primary" data-a="OC">Coordinate the offense</button>
      <button class="btn btn-primary" data-a="DC">Coordinate the defense</button>
    </div>`, async (act) => {
    const team = document.getElementById('team-pick').value;
    const shared = document.getElementById('mode-pick').value === 'rival';
    app.seat = act;
    if (!shared) {
      link.local = true;
      app.season = createSeason({ seed: Math.random().toString(36).slice(2, 10), userTeam: team });
      closeModal();
      saveSeason();
      openSeason();
      return;
    }
    try {
      const fb = await connectFirebase();
      const r = await fb.fn('createSeason')({ seat: act, displayName: nameVal(), teamId: team });
      closeModal();
      rememberSeasonCode(r.data.seasonId);
      watchSeason(fb, r.data.seasonId, r.data.seat);
      showSeasonCode(r.data.seasonId);
    } catch (e) { setupErr(e.message); closeModal(); }
  });
}

function rememberSeasonCode(id) {
  try { localStorage.setItem('booth:seasonCode', JSON.stringify({ id, at: Date.now() })); } catch {}
}
function showSeasonCode(id) {
  modal(`<h2>Send this to your rival</h2>
    <p class="code" style="margin:.4rem 0 1rem">${id}</p>
    <p>They paste it into the join box on the front page and take the other seat.
      Nothing starts until you both weigh in on week one.</p>
    <div class="modal-actions"><button class="btn btn-primary" data-a="ok">Got it</button></div>`,
    () => closeModal());
}

function openSeason() {
  app.inSeason = true;
  show('season');
  renderSeason();
}

function renderSeason() {
  const S = app.season;
  const t = TEAM_BY_ID[S.userTeam];
  const rec = seasonRecord(S);
  $('my-city').textContent = t.city;
  $('my-name').textContent = t.name;
  $('my-rec').textContent = `${rec.w}-${rec.l}${rec.t ? '-' + rec.t : ''}`;
  $('week-label').textContent = weekLabel(S.week);
  $('season-year').textContent = S.year;
  $('my-seat').textContent = app.seat === 'OC' ? 'Offense' : 'Defense';
  const tab = document.querySelector('.season-tabs .tab.is-on')?.dataset.stab || 'week';
  const pane = $('season-pane');
  pane.innerHTML = '';
  if ((S.phase === 'offseason' || S.phase === 'hired') && tab === 'week') paneOffseason(pane, S);
  else ({ week: paneWeek, standings: paneStandings, resume: paneResume, bracket: paneBracket }[tab])(pane, S);
  saveSeason();
}

document.querySelectorAll('.season-tabs .tab').forEach((t) => t.addEventListener('click', () => {
  document.querySelectorAll('.season-tabs .tab').forEach((x) => {
    const on = x === t;
    x.classList.toggle('is-on', on);
    x.setAttribute('aria-selected', String(on));
  });
  renderSeason();
}));

function paneWeek(pane, S) {
  const g = userGame(S);
  const done = g && S.results.find((r) => r.id === g.id);

  if (!g) {
    pane.append(card('Bye week', `<p class="scout-note">No game. Rest the starters and get ahead on film.</p>`));
  } else {
    const cfg = liveConfig(S, g);
    const oppRec = seasonRecord(S, cfg.them);
    const box = el('section', 'matchup');
    box.innerHTML = `<div class="matchup-line">
        <span class="ha">${cfg.atHome ? 'vs' : 'at'}</span>
        <b>${fullName(cfg.them)}</b>
        <span class="oppRec">${oppRec.w}-${oppRec.l}${oppRec.t ? '-' + oppRec.t : ''}</span>
      </div>`;
    if (done) {
      const usScore = cfg.atHome ? done.homeScore : done.awayScore;
      const themScore = cfg.atHome ? done.awayScore : done.homeScore;
      const verdict = usScore > themScore ? 'won' : usScore < themScore ? 'lost' : 'tied';
      box.insertAdjacentHTML('beforeend',
        `<p class="final-score ${verdict}">${verdict === 'won' ? 'Won' : verdict === 'lost' ? 'Lost' : 'Tied'}
         ${usScore}&ndash;${themScore}${done.played ? '' : ' <em>(staff called it)</em>'}</p>`);
    } else {
      const actions = el('div', 'matchup-actions');
      const mine = app.seasonDoc?.vote?.[app.seat] || null;
      const call = el('button', 'btn' + (mine === 'call' ? ' btn-primary' : ''), 'Call the game');
      call.addEventListener('click', () => run(link.vote('call')));
      const sim = el('button', 'btn' + (mine === 'sim' ? ' btn-primary' : ''), 'Let the staff handle it');
      sim.addEventListener('click', () => run(link.vote('sim')));
      actions.append(call, sim);
      box.append(actions);

      if (link.local) {
        box.insertAdjacentHTML('beforeend',
          `<p class="scout-note">Your staff calls an average game. Beating average is how you build a résumé.</p>`);
      } else {
        const other = app.seat === 'OC' ? 'DC' : 'OC';
        const rival = app.seasonDoc?.seats?.[other];
        const theirs = app.seasonDoc?.vote?.[other] || null;
        const line = !rival ? 'Waiting for your rival to take the other seat.'
          : mine && !theirs ? `Waiting on ${rival.displayName}.`
          : theirs === 'call' ? `${rival.displayName} wants to call it — so it gets called.`
          : theirs === 'sim' ? `${rival.displayName} would rather sim. Simming needs you both.`
          : 'Either of you can insist on calling it. Simming needs you both to agree.';
        box.insertAdjacentHTML('beforeend', `<p class="scout-note">${line}</p>`);
      }
    }
    pane.append(box);
  }

  // The rest of the league.
  const list = (S.phase === 'playoffs' ? (S.playoffs?.games || []).filter((x) => x.week === S.week)
    : weekGames(S, S.week)).filter((x) => !g || x.id !== g.id);
  const rows = list.map((x) => {
    const r = S.results.find((y) => y.id === x.id);
    return [`${TEAM_BY_ID[x.away].name} at ${TEAM_BY_ID[x.home].name}`,
      r ? `${r.awayScore}&ndash;${r.homeScore}` : '&mdash;'];
  });
  pane.append(card('Around the league', table(['', 'Final'], rows)));

  const ready = !g || !!done;
  const next = el('div', 'season-actions');
  const btn = el('button', 'btn btn-primary',
    S.phase === 'done' ? 'Black Monday'
    : S.week >= REGULAR_WEEKS && S.phase === 'regular' ? 'Start the playoffs'
    : 'Advance to next week');
  btn.disabled = !ready;
  btn.addEventListener('click', () => {
    // A shared season opens the carousel on the server, or the document stays
    // on phase 'done' while this browser shows an offseason nobody else has.
    if (S.phase === 'done' && link.local) {
      app.season = startOffseason(app.season, link.seats());
      renderSeason();
      return;
    }
    run(link.advance());
  });
  next.append(btn);
  if (!ready) next.append(el('p', 'scout-note', 'Play or sim your game first.'));
  pane.append(next);
}

/* ---------- the offseason ---------- */

function paneOffseason(pane, S) {
  const c = S.carousel;
  const seat = app.seat;
  const seats = link.seats();
  const other = seat === 'OC' ? 'DC' : 'OC';
  const rivalIn = seats.includes(other);

  if (S.phase === 'hired') {
    const mine = c.hired?.seat === seat;
    const t = TEAM_BY_ID[c.hired.teamId];
    pane.append(card(mine ? 'You got the job' : 'Your rival got out',
      `<p class="verdict-big${mine ? '' : ' lost'}">${mine
        ? `Head coach, ${t.city} ${t.name}.`
        : `${t.city} hired your rival.`}</p>
       <p class="scout-note">${mine
        ? 'Your rival is still in the booth. That was the whole game.'
        : 'You are still a coordinator. That is the game.'}</p>`));
    pane.append(decisionsCard(S));
    const again = el('div', 'season-actions');
    const b = el('button', 'btn btn-primary', 'Start a new career');
    b.addEventListener('click', () => { clearSeason(); location.reload(); });
    again.append(b);
    pane.append(again);
    return;
  }

  const R = resume(S, seat);
  const stage = c.stage || 'openings';
  const iAmReady = !!c.ready?.[seat];
  const rivalReady = !!c.ready?.[other];

  // ---- what this stage shows
  if (stage === 'openings') {
    pane.append(card('Black Monday',
      `<p class="scout-note">${c.openings.length
        ? `${c.openings.length} club${c.openings.length > 1 ? 's' : ''} changed head coach.`
        : 'Every club kept its coach. Brutal year to be looking.'}</p>`));
    pane.append(card('Your season', table(['', ''], [
      ['Record', `${R.record.w}\u2013${R.record.l}`],
      [seat === 'OC' ? 'Offense, points' : 'Defense, points allowed', ordinal(R.ranks.points)],
      ['Yards per play', ordinal(R.ranks.ypp)],
      ['Games you called yourself', `${R.gamesCalled} of ${R.gamesPlayed}`],
    ])));
    pane.append(vacancyCard(S, seat));
  } else if (stage === 'interviews') {
    pane.append(vacancyCard(S, seat));
    const left = interviewsLeft(S, seat);
    if (left.length) {
      const box = el('div', 'season-actions');
      for (const id of left) {
        const o = c.openings.find((x) => x.teamId === id);
        const b = el('button', 'btn btn-primary', `Interview with ${TEAM_BY_ID[id].name}`);
        b.addEventListener('click', () => runInterview(o));
        box.append(b);
      }
      pane.append(box);
    }
  } else if (stage === 'scouting') {
    paneScouting(pane, S, seat);
  } else if (stage === 'draft') {
    pane.append(card('Your draft', (S.draftResult || []).length
      ? table(['Round', '', 'Rating', '', ''], S.draftResult.map((p) => [
          `R${p.round} #${p.overall}`, `${p.pos} ${p.name}`, `${p.rating}`,
          p.started ? `<b class="invited">starts</b>` : 'depth',
          p.pounded ? 'you pushed for him' : '']))
      : note('Your club had no picks left by the time the board came round.'))
      + noteEl('The general manager made these calls, not you.'));
    const missed = S.missedTargets || [];
    if (missed.length) {
      pane.append(card('He passed on', table(['', 'You had him at'], missed.map((p) => {
        const v = scoutView(p);
        return [`${p.pos} ${p.name}`,
          `${v.floor}\u2013${v.ceiling}${p.revealed ? ` &middot; really ${p.revealed}` : ''}`];
      })) + noteEl('You made the case. He went another way.')));
    }
    const fa = S.signed?.[seat];
    if (fa) pane.append(card('Free agency', table(['', 'Rating'], [[`${fa.pos} ${fa.name}`, `${fa.rating}`]])));
  } else {
    pane.append(card(c.hired
      ? (c.hired.seat === seat ? 'You got the job' : 'Your rival got out')
      : 'Nobody hired you',
      c.hired
        ? `<p class="verdict-big${c.hired.seat === seat ? '' : ' lost'}">${
            TEAM_BY_ID[c.hired.teamId].city} ${c.hired.seat === seat ? 'is yours' : 'hired your rival'}.</p>`
        : `<p class="scout-note">The jobs went elsewhere. Build a better r\u00e9sum\u00e9.</p>`));
    pane.append(decisionsCard(S));
  }

  // ---- the same ready-up rhythm as a game week
  const box = el('div', 'season-actions');
  const labels = {
    openings: 'Ready for interviews',
    interviews: 'Done interviewing',
    decisions: c.hired ? 'Finish' : 'On to the draft',
    scouting: 'Set the board and run the draft',
    draft: 'Back to the booth for another year',
  };
  const b = el('button', 'btn' + (iAmReady ? '' : ' btn-primary'), iAmReady ? 'Waiting…' : labels[stage]);
  b.disabled = !canReady(S, seat) || iAmReady;
  b.addEventListener('click', () => run(link.ready(true)));
  box.append(b);

  if (!canReady(S, seat)) {
    box.append(el('p', 'scout-note', 'Sit down with every club that called first.'));
  } else if (rivalIn) {
    box.append(el('p', 'scout-note', rivalReady
      ? 'Your rival is ready. This should move any moment.'
      : iAmReady ? 'Waiting on your rival.'
      : 'You both have to be ready before this moves on.'));
  }
  pane.append(box);
}

/** Your side of the board, with the uncertainty visible. */
function paneScouting(pane, S, seat) {
  const side = seat === 'OC' ? 'offense' : 'defense';
  const left = S.scoutLeft?.[seat] ?? 0;
  const inf = S.influence?.[seat] ?? 0;
  const other = seat === 'OC' ? 'DC' : 'OC';
  const pounded = S.lobby?.table?.[seat] || [];
  const mePush = S.lobby?.[seat] || 0, themPush = S.lobby?.[other] || 0;

  pane.append(card(`Scouting \u2014 ${left} look${left === 1 ? '' : 's'} left`,
    noteEl('A range is what your area scouts have so far. Looks narrow it, they never close it.')));

  // The tug of war. Neither coordinator picks; you are both working the GM.
  const total = Math.max(1, mePush + themPush);
  const bar = el('section', 'scout-block', '<h3>The room</h3>');
  bar.insertAdjacentHTML('beforeend',
    `<div class="tug"><span class="tug-me" style="width:${(mePush / total) * 100}%"></span></div>`
    + `<p class="scout-note" style="padding:.4rem .6rem 0">You have leaned in ${mePush} time${mePush === 1 ? '' : 's'};
        ${seat === 'OC' ? 'the defensive' : 'the offensive'} coordinator ${themPush}.
        ${mePush > themPush ? 'He is listening to you.' : themPush > mePush
          ? 'He is listening to your rival.' : 'Nobody has his ear yet.'}</p>`);
  const push = el('div', 'lobby-actions');
  const pb = el('button', 'btn btn-primary',
    `Make the case for ${seat === 'OC' ? 'offense' : 'defense'}`);
  pb.disabled = inf < 1;
  pb.addEventListener('click', () => run(link.lobbySide()));
  push.append(pb, el('p', 'scout-note', `${inf} influence left. Pounding the table for one player costs two.`));
  bar.append(push);
  pane.append(bar);

  // Always render from the published view. In a shared season the true ratings
  // are not in this document at all.
  const view = S.boardView?.[seat] || {};
  const board = (S.boardPublic || S.board || []).filter((p) => p.side === side).slice(0, 24);
  const scoutedCount = (id) => (S.board || []).find((x) => x.id === id)?.scouted;
  const rows = board.map((p) => {
    const v = view[p.id] || scoutView(p);
    const on = pounded.includes(p.id);
    return [
      `${on ? '<mark>' : ''}${p.pos} ${p.name}${on ? '</mark>' : ''}`,
      `${v.floor}\u2013${v.ceiling}`,
      v.confidence === 'high' ? 'sure' : v.confidence === 'some' ? 'partial' : '\u2014',
      `<button class="btn btn-tiny" data-scout="${p.id}"${left <= 0 || v.confidence === 'high' ? ' disabled' : ''}>Look</button>`
      + ` <button class="btn btn-tiny" data-table="${p.id}"${!on && inf < 2 ? ' disabled' : ''}>${on ? 'Back off' : 'Pound the table'}</button>`,
    ];
  });
  pane.append(card('Prospects', table(['', 'Range', 'Read', ''], rows)
    + noteEl('You do not make the pick. The general manager does, off his own board, '
      + 'and he is wrong in his own direction. All you can do is argue.')));

  const fas = (S.freeAgents || []).filter((f) => f.side === side).slice(0, 8);
  const already = S.signed?.[seat];
  pane.append(card('Free agents', already
    ? note(`You signed ${already.pos} ${already.name}.`)
    : table(['', 'Rating', 'Age', ''], fas.map((f) => [
        `${f.pos} ${f.name}`, `${f.rating}`, `${f.age}`,
        `<button class="btn btn-tiny" data-sign="${f.id}">Sign</button>`]))
      + noteEl('Their tape is public, so the rating is real. The risk is what age does next.')));

  pane.querySelectorAll('[data-scout]').forEach((b) => b.addEventListener('click', () => {
    run(link.scoutLook(b.dataset.scout));
  }));
  pane.querySelectorAll('[data-table]').forEach((b) => b.addEventListener('click', () => {
    run(link.lobbyPlayer(b.dataset.table));
  }));
  pane.querySelectorAll('[data-sign]').forEach((b) => b.addEventListener('click', () => {
    run(link.sign(b.dataset.sign));
  }));
}

function vacancyCard(S, seat) {
  const c = S.carousel;
  const invited = new Set(c.invited[seat] || []);
  const banked = c.banked?.[seat] || {};
  const rows = c.openings.map((o) => {
    const fit = c.resumeScores[seat]?.[o.teamId] ?? 0;
    const status = banked[o.teamId] ? 'Interviewed'
      : invited.has(o.teamId) ? '<b class="invited">Wants to talk</b>' : 'No call';
    return [fullName(o.teamId), o.label, `${Math.round(fit)}`, status];
  });
  return card('Head coaching vacancies',
    (rows.length ? table(['Club', 'Looking for', 'Fit', ''], rows)
      : note('No vacancies this year.'))
    + noteEl('Fit is how they read your r\u00e9sum\u00e9. The interview is the other half.'));
}

/** What every club decided, in one place. */
function decisionsCard(S) {
  const rows = (S.carousel.decisions || []).map((d) => [
    fullName(d.teamId),
    d.hiredSeat ? `<mark>${d.hiredName}</mark>` : d.hiredName || '\u2014',
  ]);
  return card('How the jobs went', rows.length ? table(['Club', 'Hired'], rows)
    : note('No vacancies this year.'));
}

/** Five questions, one at a time. The club is described first — reading the
 *  opening is the actual skill being tested. */
function runInterview(opening) {
  const qs = interviewQuestions(app.season.seed, opening.teamId, app.seat);
  const answers = [];
  const arch = archetypeOf(opening.archetype);
  const t = TEAM_BY_ID[opening.teamId];

  const ask = (i) => {
    if (i >= qs.length) {
      closeModal();
      run(link.interview(opening.teamId, answers));
      return;
    }
    const q = qs[i];
    const opts = q.options.map((o, k) =>
      `<button class="btn iv-option" data-a="${k}">${o.t}</button>`).join('');
    modal(`<h2>${t.city} ${t.name}</h2>
      <p class="iv-meta">${opening.record.w}&ndash;${opening.record.l} &middot; ${arch.label}
        &middot; question ${i + 1} of ${qs.length}</p>
      <p class="iv-blurb">${arch.blurb}</p>
      <p class="iv-q">${q.q}</p>
      <div class="iv-options">${opts}</div>`, (choice) => {
      answers.push(Number(choice));   // indices only; the score is computed elsewhere
      $('veil').dataset.html = '';
      ask(i + 1);
    });
  };
  ask(0);
}

function paneStandings(pane, S) {
  const st = sortedStandings(S.results.filter((r) => !r.playoff));
  for (const conf of ['N', 'S']) {
    const wrap = el('div', 'conf-block', `<h2 class="conf-title">${conf === 'N' ? 'Northern' : 'Southern'} Conference</h2>`);
    for (const div of DIVISIONS.filter((d) => d[0] === conf)) {
      wrap.append(card(div, table(['', 'W', 'L', 'PF', 'PA'],
        st.divisions[div].map((r) => [
          `${r.id === S.userTeam ? '<mark>' : ''}${fullName(r.id)}${r.id === S.userTeam ? '</mark>' : ''}`,
          `${r.w}`, `${r.l}`, `${r.pf}`, `${r.pa}`]))));
    }
    pane.append(wrap);
  }
}

function paneResume(pane, S) {
  const R = resume(S, app.seat);
  const label = app.seat === 'OC' ? 'Offense' : 'Defense';
  pane.append(card(`${label} — where you rank`, table(['', 'You', 'League rank'], [
    ['Yards per play', R.stats.ypp.toFixed(2), ordinal(R.ranks.ypp)],
    [app.seat === 'OC' ? 'Points per game' : 'Points allowed', R.stats.pointsPerGame.toFixed(1), ordinal(R.ranks.points)],
    ['Third down', (R.stats.third * 100).toFixed(1) + '%', ordinal(R.ranks.third)],
    ['Turnovers per game', R.stats.turnoversPerGame.toFixed(2), ordinal(R.ranks.turnovers)],
  ]) + `<p class="scout-note">Record ${R.record.w}&ndash;${R.record.l}. You called
    ${R.gamesCalled} of ${R.gamesPlayed} games yourself.</p>`));

  const rows = R.league.stats
    .map((s) => ({ id: s.id, v: s[R.unit].ypp }))
    .sort((a, b) => (app.seat === 'OC' ? b.v - a.v : a.v - b.v))
    .slice(0, 8)
    .map((r, i) => [`${i + 1}. ${fullName(r.id)}`, r.v.toFixed(2)]);
  pane.append(card(`League leaders — ${label.toLowerCase()} yards per play`, table(['', 'Y/P'], rows)));
}

function paneBracket(pane, S) {
  if (!S.playoffs) {
    pane.append(card('Playoffs', `<p class="scout-note">The bracket sets after week ${REGULAR_WEEKS}.</p>`));
    return;
  }
  for (const conf of ['N', 'S']) {
    pane.append(card(`${conf === 'N' ? 'Northern' : 'Southern'} seeds`,
      table(['', 'Seed', 'Record'], S.playoffs.seeds[conf].map((s) => [
        `${s.id === S.userTeam ? '<mark>' : ''}${fullName(s.id)}${s.id === S.userTeam ? '</mark>' : ''}`,
        `${s.seed}`, `${s.w}-${s.l}`]))));
  }
  const played = S.playoffs.games.map((g) => {
    const r = S.results.find((x) => x.id === g.id);
    return [weekLabel(g.week), `${TEAM_BY_ID[g.away].name} at ${TEAM_BY_ID[g.home].name}`,
      r ? `${r.awayScore}&ndash;${r.homeScore}` : '&mdash;'];
  });
  if (played.length) pane.append(card('Results', table(['Round', '', 'Final'], played)));
  if (S.champion) pane.append(card('Champion', `<p class="scout-note">${fullName(S.champion)}.</p>`));
}

const ordinal = (n) => {
  const s = ['th', 'st', 'nd', 'rd'], v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
};
function card(title, inner) {
  const box = el('section', 'scout-block', `<h3>${title}</h3>`);
  box.insertAdjacentHTML('beforeend', inner);
  return box;
}

/** Hand this week's matchup to the snap engine. */
async function startSeasonGame(cfg) {
  app.t = new LocalTransport();
  await app.t.create({
    name: app.name, seat: app.seat,
    teamName: cfg.teamName, oppName: cfg.oppName,
    rosters: cfg.rosters, firstPossession: cfg.firstPossession,
    autoSeat: app.seat === 'OC' ? 'DC' : 'OC',
  });
  app.liveCfg = cfg;
  app.viewSeat = app.seat;
  app.t.subscribe(render);
  show('game');
}

/* ---------- render ---------- */

function render(g, plays) {
  if (!g) return;
  if (g.status === 'lobby' || (g.status === 'paused' && !app.t.local)) {
    renderLobby(g);
    if (g.status === 'lobby') { show('lobby'); return; }
  }
  show('game');

  const s = g.state;
  const mine = app.inSeason ? app.seat : (app.t.local ? (app.viewSeat || seatOnClock(s)) : app.t.mySeat);
  const onClock = seatOnClock(s);
  const isMyCall = mine === onClock && g.status === 'live';

  const log = plays || [];
  app.record = callRecord(log, mine);

  renderBoard(g, s);
  renderField(g, s, log);
  renderFeed(g, log);
  renderScouting(g, s, mine, log);
  renderPlayers(g, mine, log);
  renderChirps(g);

  const seatBtn = $('btn-seat');
  seatBtn.hidden = !app.t.local || !!app.inSeason;
  seatBtn.textContent = `View: ${mine === 'OC' ? 'offense' : 'defense'}`;

  $('film').innerHTML = `Film <b>${g.filmPoints?.[mine] || 0}</b>`;
  $('btn-keys').hidden = !isMyCall;
  $('btn-keys').disabled = (g.filmPoints?.[mine] || 0) < FILM_COST;

  const hint = g.pending?.hint;
  $('hint').hidden = !(hint && hint.seat === mine && hint.playIndex === s.playIndex);
  if (!$('hint').hidden) $('hint').textContent = hint.text;

  $('tempo-row').hidden = !(isMyCall && mine === 'OC');
  document.querySelectorAll('#tempo-row .chip').forEach((c) => {
    c.classList.toggle('is-on', c.dataset.tempo === (g.gameplan?.OC?.tempo || 'normal'));
  });

  if (g.status === 'final') { renderFinal(g, plays || []); return; }
  if (isMyCall) renderCallSheet(g, s, mine);
  else renderPrep(g, s, mine, onClock);

  managePause(g);
  managePlayClock(g);
}

function renderLobby(g) {
  $('lobby-code').textContent = g.id;
  for (const seat of ['OC', 'DC']) {
    const row = $('row-' + seat);
    const p = g.seats?.[seat];
    row.querySelector('span').textContent = p ? `${p.displayName}${p.ready ? ' — ready' : ''}` : 'Open seat';
    row.classList.toggle('is-ready', !!p?.ready);
  }
}

function renderBoard(g, s) {
  $('us-name').textContent = g.teamName.toUpperCase();
  $('them-name').textContent = g.oppName.toUpperCase();
  $('us-score').textContent = s.score.us;
  $('them-score').textContent = s.score.them;
  $('qtr').textContent = ORD[s.quarter] || 'OT';
  $('clock').textContent = mmss(s.clock);

  $('poss-us').hidden = s.possession !== 'US';
  $('poss-them').hidden = s.possession !== 'CPU';

  const goalToGo = s.distance >= 100 - s.ballOn;
  $('dnd').textContent = `${ORD[s.down]} & ${goalToGo ? 'Goal' : s.distance}`;

  const side = s.possession === 'US' ? g.teamName : g.oppName;
  $('spot').textContent = s.ballOn === 50 ? 'Ball on midfield'
    : s.ballOn < 50 ? `Ball on ${abbr(side)} ${s.ballOn}`
    : `Ball on ${abbr(s.possession === 'US' ? g.oppName : g.teamName)} ${100 - s.ballOn}`;
}

/* The field is drawn on the same pad as the call sheet: green wash, printed
   yard lines, and the coach's red pencil tracing where the ball just went.
   US always attacks right, so field position reads the same way all game. */
const EZ = 9, FW = 100, VW = 118, VH = 28;
const xAt = (abs) => EZ + (abs / 100) * FW;

function renderField(g, s, plays) {
  const box = $('field');
  const losAbs = s.possession === 'US' ? s.ballOn : 100 - s.ballOn;
  const dir = s.possession === 'US' ? 1 : -1;
  const goalToGo = s.distance >= 100 - s.ballOn;
  const fdAbs = goalToGo ? (s.possession === 'US' ? 100 : 0) : losAbs + dir * s.distance;

  const parts = [];
  parts.push(`<svg viewBox="0 0 ${VW} ${VH}" xmlns="http://www.w3.org/2000/svg" class="fieldsvg">`);

  // turf and end zones
  parts.push(`<rect x="0" y="0" width="${VW}" height="${VH}" rx="0.6" class="turf"/>`);
  parts.push(`<rect x="0" y="0" width="${EZ}" height="${VH}" class="ez"/>`);
  parts.push(`<rect x="${VW - EZ}" y="0" width="${EZ}" height="${VH}" class="ez"/>`);
  parts.push(`<text x="${EZ / 2}" y="${VH / 2}" class="ez-label" transform="rotate(-90 ${EZ / 2} ${VH / 2})">${abbr(g.teamName)}</text>`);
  parts.push(`<text x="${VW - EZ / 2}" y="${VH / 2}" class="ez-label" transform="rotate(90 ${VW - EZ / 2} ${VH / 2})">${abbr(g.oppName)}</text>`);

  // yard lines every five, numbers every ten
  for (let y = 0; y <= 100; y += 5) {
    const x = xAt(y);
    parts.push(`<line x1="${x}" y1="0" x2="${x}" y2="${VH}" class="yl${y % 10 ? ' minor' : ''}${y === 50 ? ' fifty' : ''}"/>`);
    if (y % 10 === 0 && y > 0 && y < 100) {
      const n = y <= 50 ? y : 100 - y;
      parts.push(`<text x="${x}" y="${VH - 2.2}" class="yn">${n}</text>`);
      parts.push(`<text x="${x}" y="5.2" class="yn">${n}</text>`);
    }
  }
  // hash marks
  for (let y = 1; y < 100; y++) {
    const x = xAt(y);
    parts.push(`<line x1="${x}" y1="9.4" x2="${x}" y2="10.8" class="hash"/>`);
    parts.push(`<line x1="${x}" y1="${VH - 10.8}" x2="${x}" y2="${VH - 9.4}" class="hash"/>`);
  }

  // last play, traced in pencil
  const last = [...(plays || [])].reverse().find((p) => p.outcome);
  if (last) {
    const pd = last.possession === 'US' ? 1 : -1;
    const from = last.possession === 'US' ? last.ballOn : 100 - last.ballOn;
    const o = last.outcome;
    let to = from, kick = false;
    if (o.special === 'punt') { to = losAbs; kick = true; }        // ends where the ball ends, touchback and all
    else if (o.special === 'fg') { to = pd > 0 ? 100 : 0; kick = true; }
    else if (!o.special) to = from + pd * (o.yards || 0);
    to = Math.max(0, Math.min(100, to));
    if (Math.abs(to - from) > 0.4) {
      const x1 = xAt(from), x2 = xAt(to), mid = (x1 + x2) / 2;
      const lift = kick ? 7.5 : Math.min(5, 1.4 + Math.abs(x2 - x1) * 0.11);
      const miss = o.special === 'fg' && !o.made ? ' miss' : '';
      const y = VH / 2;
      if (kick) {
        parts.push(`<path d="M ${x1} ${y} Q ${mid} ${y - lift} ${x2} ${y}" class="trace kick${miss}"/>`);
      } else {
        // The curve leaves its control point on a slant, so the head has to sit
        // on that tangent rather than flat along the x axis.
        const ctrl = [mid, y - lift];
        const tip = [x2, y];
        const { base, points } = arrow(ctrl, tip, 2.0, 1.0);
        parts.push(`<path d="M ${x1} ${y} Q ${ctrl[0]} ${ctrl[1]} ${base[0].toFixed(2)} ${base[1].toFixed(2)}" class="trace"/>`);
        parts.push(`<polygon points="${points}" class="tracehead"/>`);
      }
    }
  }

  // line of scrimmage and the line to gain — broadcast colours, so they read instantly
  parts.push(`<line x1="${xAt(fdAbs)}" y1="0.5" x2="${xAt(fdAbs)}" y2="${VH - 0.5}" class="fd"/>`);
  parts.push(`<line x1="${xAt(losAbs)}" y1="0.5" x2="${xAt(losAbs)}" y2="${VH - 0.5}" class="los"/>`);
  parts.push(`<ellipse cx="${xAt(losAbs)}" cy="${VH / 2}" rx="1.5" ry="1" class="pill"/>`);
  parts.push('</svg>');
  box.innerHTML = parts.join('');

  const side = s.possession === 'US' ? g.teamName : g.oppName;
  const spot = s.ballOn === 50 ? 'midfield'
    : s.ballOn < 50 ? `${side} ${s.ballOn}` : `${s.possession === 'US' ? g.oppName : g.teamName} ${100 - s.ballOn}`;
  $('field-note').textContent = `${s.possession === 'US' ? g.teamName : g.oppName} ball on the ${spot} — `
    + (goalToGo ? 'goal to go' : `${s.distance} to gain`);
}

function renderCallSheet(g, s, mine) {
  $('call-title').textContent = mine === 'OC' ? 'Your call — offense' : 'Your call — defense';
  const sheet = $('sheet');
  sheet.className = 'sheet';
  sheet.innerHTML = '';

  const mk = (id, name, tag, handler) => {
    // Show a call's own record once there's enough of it to mean anything.
    const r = app.record?.[id];
    const stat = r && r.n >= 2
      ? `<u title="${r.n} calls, ${pct(r.success)} on schedule">${r.n}&times; &middot; ${r.ypp.toFixed(1)}</u>`
      : '';
    const b = el('button', 'call', `<b>${name}</b><span>${tag}</span>${stat}`);
    b.addEventListener('click', () => handler(b));
    return b;
  };
  const commit = (payload) => async (btn) => {
    if (app.busy) return;
    app.busy = true;
    sheet.classList.add('is-locked');
    btn.classList.add('is-picked');
    try { await app.t.call(payload); }
    catch (e) { flash(e.message); sheet.classList.remove('is-locked'); btn.classList.remove('is-picked'); }
    finally { app.busy = false; }
  };

  if (mine === 'OC') {
    if (s.down === 4) {
      const grp = el('div', 'group', '<h3>Fourth down</h3>');
      grp.append(mk('punt', 'Punt', 'Flip the field', commit({ special: 'punt' })));
      const pct = Math.round(fieldGoalProb(s.ballOn) * 100);
      grp.append(mk('fg', 'Field goal', `${100 - s.ballOn + 17} yards · ${pct}%`, commit({ special: 'fg' })));
      sheet.append(grp);
    }
    if (s.quarter >= 4 && s.clock < 150 && s.score.us > s.score.them) {
      const grp = el('div', 'group', '<h3>Clock</h3>');
      grp.append(mk('kneel', 'Kneel', 'Burn 40 seconds', commit({ special: 'kneel' })));
      sheet.append(grp);
    } else if (s.clock < 90 && !s.clockStopped) {
      const grp = el('div', 'group', '<h3>Clock</h3>');
      grp.append(mk('spike', 'Spike', 'Stop the clock', commit({ special: 'spike' })));
      sheet.append(grp);
    }
    const mine = OFFENSE.filter((p) => p.custom);
    if (mine.length) {
      const box = el('div', 'group', '<h3>Your install</h3>');
      mine.forEach((p) => box.append(mk(p.id, p.name, `${p.pers} \u00b7 ${p.tag}`, commit({ callId: p.id }))));
      sheet.append(box);
    }
    for (const grp of OFF_GROUPS) {
      const box = el('div', 'group', `<h3>${grp.title}</h3>`);
      OFFENSE.filter(grp.has).forEach((p) => box.append(mk(p.id, p.name, `${p.pers} · ${p.tag}`, commit({ callId: p.id }))));
      sheet.append(box);
    }
  } else {
    const mine = DEFENSE.filter((d) => d.custom);
    if (mine.length) {
      const box = el('div', 'group', '<h3>Your install</h3>');
      mine.forEach((d) => box.append(mk(d.id, d.name, d.tag, commit({ callId: d.id }))));
      sheet.append(box);
    }
    for (const grp of DEF_GROUPS) {
      const box = el('div', 'group', `<h3>${grp.title}</h3>`);
      grp.ids.forEach((id) => { const d = DEF_BY_ID[id]; box.append(mk(id, d.name, d.tag, commit({ callId: id }))); });
      sheet.append(box);
    }
  }
}

function renderPrep(g, s, mine, onClock) {
  const other = g.seats?.[onClock]?.displayName || (onClock === 'OC' ? 'Offense' : 'Defense');
  $('call-title').textContent = `${other} is on the clock`;
  const sheet = $('sheet');
  sheet.className = 'prep';
  sheet.innerHTML = '';

  // 1. Read the call — the idle coordinator's job.
  const guesses = mine === 'OC' ? GUESS_OFF : GUESS_DEF;
  const subject = mine === 'OC' ? `${g.oppName}'s offense` : `${g.oppName}'s defense`;
  const pred = g.pending?.prediction;
  const block = el('div', 'prep-block',
    `<h3>Read the call</h3><p>Call what ${subject} runs on this snap. Every hit banks a film point your unit can spend.</p>`);
  const row = el('div', 'guess');
  guesses.forEach(([id, label]) => {
    const c = el('button', 'chip', label);
    if (pred && pred.seat === mine && pred.guess === id) c.classList.add('is-on');
    c.addEventListener('click', async () => {
      try { await app.t.predict(id, mine); } catch (e) { flash(e.message); }
    });
    row.append(c);
  });
  block.append(row);
  sheet.append(block);

  // 2. Gameplan — only controls that actually move the engine.
  if (mine === 'OC') {
    const plan = g.gameplan?.OC || { aggression: 0, tempo: 'normal' };
    const b = el('div', 'prep-block',
      `<h3>Next series</h3><p>Aggression shifts your shot plays up and your checkdowns down. It applies on the next snap.</p>`);
    const sl = el('div', 'slider',
      `<label for="agg">Aggression</label><input id="agg" type="range" min="-1" max="1" step="0.25" value="${plan.aggression}"><output id="agg-out">${aggLabel(plan.aggression)}</output>`);
    b.append(sl);
    sheet.append(b);
    const input = sl.querySelector('input');
    input.addEventListener('input', () => { sl.querySelector('output').textContent = aggLabel(+input.value); });
    input.addEventListener('change', () => app.t.plan('OC', { ...plan, aggression: +input.value }));
  }

  // 3. Tendency report — how readable you are, or what the CPU likes.
  const which = mine === 'OC' ? 'US' : 'CPU';
  const t = g.tendencies?.[which];
  const label = mine === 'OC' ? 'Your tendencies' : `${g.oppName} tendencies`;
  const probs = readTendencies(t, s);
  const rep = el('div', 'prep-block',
    `<h3>${label}</h3><p>On ${ORD[s.down]} and ${distBucket(s.distance)}, ${(t?.plays || 0)} snaps charted.</p>`);
  const lines = el('div', 'tendency');
  Object.entries(probs).sort((a, b) => b[1] - a[1]).slice(0, 4).forEach(([f, p]) => {
    lines.append(el('div', null,
      `${f.padEnd(11).replace(/ /g, '&nbsp;')}<i class="bar" style="width:${Math.round(p * 90)}px"></i><b>${Math.round(p * 100)}%</b>`));
  });
  rep.append(lines);
  sheet.append(rep);
}

const pct = (x) => (x == null ? '—' : `${Math.round(x * 100)}%`);
const num = (x, d = 1) => (x == null ? '—' : x.toFixed(d));

const aggLabel = (v) => v <= -0.75 ? 'Ball control' : v < 0 ? 'Careful' : v === 0 ? 'Balanced' : v < 0.75 ? 'Attacking' : 'Reckless';

function renderFeed(g, plays) {
  const box = $('lastplay');
  // Everything from the snap you called through any kick the CPU took after it.
  // Showing only the newest play made your own result vanish.
  let cut = -1;
  for (let i = plays.length - 1; i >= 0; i--) if (plays[i].byHuman) { cut = i; break; }
  const batch = cut >= 0 ? plays.slice(cut) : plays.slice(-1);

  if (batch.length && batch[0].outcome) {
    box.hidden = false;
    box.innerHTML = '';
    batch.forEach((p, idx) => {
      const o = p.outcome;
      const off = p.offId ? OFF_BY_ID[p.offId]?.name : (p.special ? 'Special teams' : '');
      const def = p.defId ? DEF_BY_ID[p.defId]?.name : '';
      const ours = p.possession === 'US';
      const row = el('div', idx ? 'then' : '');
      row.innerHTML = `<div class="matchup">
          <em>${situationLabel(p, g)}</em>
          ${ours ? off : `<i>${off}</i>`}${def ? (ours ? ' vs <i>' + def + '</i>' : ' vs ' + def) : ''}
        </div><div class="result">${o.desc || ''}</div>`;
      if (!p.special && o.yards != null && !o.penalty) {
        // Judge the play from the seat of whoever is reading it: an offense
        // stalling is a bad result on your drive and a good one on your stop.
        const onSchedule = isSuccess(p.down, p.distance, o.yards);
        const good = ours ? onSchedule : !onSchedule;
        const word = ours
          ? (onSchedule ? 'on schedule' : 'behind the sticks')
          : (onSchedule ? 'they stay on schedule' : 'stop');
        row.querySelector('.result').insertAdjacentHTML('beforeend',
          ` <span class="verdict ${good ? 'good' : 'bad'}">${word}</span>`);
      }
      if (o.readEdge < -0.02) row.append(el('div', 'tell', 'They read it. You have shown that look too often here.'));
      if (o.predictionHit) row.append(el('div', 'tell', `Read confirmed: ${o.predictionActual}. +1 film point.`));
      box.append(row);
    });
  } else box.hidden = true;

  const feed = $('feed');
  feed.innerHTML = '';
  for (const p of plays.slice(-40).reverse()) {
    const o = p.outcome || {};
    let cls = '';
    if ((p.events || []).some((e) => e.type === 'score')) cls = 'score-play';
    else if (o.turnover) cls = 'turnover';
    else if (Math.abs(o.yards || 0) >= 15) cls = 'big';
    const li = el('li', cls,
      `<span class="t">Q${p.quarter} ${mmss(p.clock)}</span>` +
      `<span class="dd">${p.possession === 'US' ? abbr(g.teamName) : abbr(g.oppName)} ${p.down}&amp;${p.distance}</span>` +
      `<span>${o.desc || ''}${(p.events || [])
        .filter((e) => e.type === 'score' || e.type === 'period')
        .map((e) => ' ' + e.text).join('')}</span>`);
    feed.append(li);
  }
}

/** "IRO 4th & 6 at the CAS 38" — names both teams, so nothing is ambiguous. */
function situationLabel(p, g) {
  const withBall = p.possession === 'US' ? g.teamName : g.oppName;
  const other = p.possession === 'US' ? g.oppName : g.teamName;
  const spot = p.ballOn === 50 ? 'midfield'
    : p.ballOn < 50 ? `${abbr(withBall)} ${p.ballOn}` : `${abbr(other)} ${100 - p.ballOn}`;
  const goal = p.distance >= 100 - p.ballOn;
  return `${abbr(withBall)} ball &middot; ${ORD[p.down]} &amp; ${goal ? 'goal' : p.distance} at the ${spot}`;
}

/* ---------- scouting ---------- */
/* Everything here is history. Nothing here tells you what is coming on this
   snap — that is what film points are for, and the two are meant to stack:
   frequencies tell you it's mostly zone here, keys tell you which zone now. */

function renderScouting(g, s, mine, plays) {
  const pane = $('pane-scout');
  if (pane.hidden) return;
  pane.innerHTML = '';

  const bucket = distBucket(s.distance);
  const label = `${ORD[s.down]} & ${bucket === 'short' ? 'short' : bucket === 'med' ? 'medium' : 'long'}`;

  // Widen the window automatically rather than showing an empty table.
  const exact = mine === 'OC' ? shellReport(plays, s, 'exact') : opponentReport(plays, s, mine, 'exact');
  const wide = mine === 'OC' ? shellReport(plays, s, 'down') : opponentReport(plays, s, mine, 'down');
  const rep = exact.total >= 4 ? exact : wide;
  const scope = exact.total >= 4 ? label : `${ORD[s.down]} down, any distance`;

  pane.append(section(
    mine === 'OC' ? `What ${g.oppName} shows on ${scope}` : `What ${g.oppName} runs on ${scope}`,
    rep.total
      ? table(
          ['', 'Freq', mine === 'OC' ? 'Yds/play' : 'Yds/play', 'Success'],
          rep.rows.slice(0, 6).map((r) => [
            r.label, pct(r.share), num(r.ypp), pct(r.success),
          ]))
      : note('No snaps charted here yet.')));

  // Self-scout: how readable am I right here?
  if (mine === 'OC') {
    const me = selfScout(plays, s, g.tendencies?.US);
    const msg = { thin: 'Too few snaps here to have a tell yet.',
      low: 'You are balanced here. Nothing to read.',
      some: 'A lean is forming. They may start guessing right.',
      high: 'You are tipping this situation. Expect them to sit on it.' }[me.risk];
    pane.append(section(`Your calls on ${label}`,
      (me.total
        ? table(['', 'Freq', 'Called'], me.rows.map((r) => [r.label, pct(r.share), `${r.n}`]))
        : note('No snaps charted here yet.')) + noteEl(msg, me.risk === 'high' ? 'warn' : '')));
  }

  // Your own best and worst calls, so the sheet earns its numbers.
  const rec = Object.entries(app.record || {})
    .filter(([, r]) => r.n >= 2)
    .map(([id, r]) => ({ name: (mine === 'OC' ? OFF_BY_ID[id] : DEF_BY_ID[id])?.name || id, ...r }))
    .sort((a, b) => (mine === 'OC' ? b.ypp - a.ypp : a.ypp - b.ypp));
  pane.append(section(mine === 'OC' ? 'Your calls, by yards per play' : 'Your calls, by yards allowed',
    rec.length
      ? table(['', 'Called', 'Yds/play', 'Success'],
          rec.slice(0, 8).map((r) => [r.name, `${r.n}`, num(r.ypp), pct(r.success)]))
      : note('Call a play twice and it shows up here.')));

  // Where the game stands.
  const u = unitSummary(plays);
  const o = u.offense, d = u.defense;
  pane.append(section('This game', table(
    ['', 'Offense', 'Defense'],
    [
      ['Plays', `${o.n}`, `${d.n}`],
      ['Yards / play', num(o.ypp, 2), num(d.ypp, 2)],
      ['Success rate', pct(o.success), pct(d.success)],
      ['Third down', pct(o.third), pct(d.third)],
      ['Explosives', pct(o.explosive), pct(d.explosive)],
      ['Turnovers', `${o.turnovers}`, `${d.turnovers}`],
    ])));

  pane.insertAdjacentHTML('beforeend',
    `<p class="legend">A play is a <b>success</b> if it keeps the drive on schedule:
     40% of the distance on first down, 60% on second, all of it on third and fourth.</p>`);
}

function section(title, inner) {
  const box = el('section', 'scout-block', `<h3>${title}</h3>`);
  box.insertAdjacentHTML('beforeend', inner);
  return box;
}
const note = (t) => `<p class="scout-note">${t}</p>`;
const noteEl = (t, cls) => `<p class="scout-note ${cls || ''}">${t}</p>`;
function table(head, rows) {
  return `<table class="scout"><thead><tr>${head.map((h, i) =>
    `<th${i ? ' class="n"' : ''}>${h}</th>`).join('')}</tr></thead><tbody>${
    rows.map((r) => `<tr>${r.map((c, i) =>
      `<td${i ? ' class="n"' : ''}>${c}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
}

/* ---------- players ----------
   The box score is a record of what happened. Over one game it is mostly
   variance, so the matchup board sits above it: that is the stable signal,
   and it is computed from the same numbers the resolver uses. */

function renderPlayers(g, mine, plays) {
  const pane = $('pane-players');
  if (pane.hidden) return;
  pane.innerHTML = '';
  const R = makeRosters(g.rosterSeed || g.id);

  const attacking = mine === 'OC';
  const off = attacking ? R.US.offense : R.CPU.offense;
  const def = attacking ? R.CPU.defense : R.US.defense;

  // Who has the advantage, and where.
  const board = matchupBoard(off, def);
  pane.append(section(
    attacking ? `Your receivers vs ${g.oppName}` : `${g.oppName} receivers vs your coverage`,
    table(['', 'Covered by', 'Edge'], board.map((m) => [
      nameCell(m.target),
      nameCell(m.defender),
      `<span class="gap ${m.manGap > 6 ? 'good' : m.manGap < -6 ? 'bad' : ''}">${m.manGap > 0 ? '+' : ''}${m.manGap}</span>`,
    ]))
    + noteEl(attacking
      ? 'Man coverage pays this in full. In zone it is worth about half.'
      : 'This is where they will attack you. In zone the gap roughly halves.')));

  // What has actually happened.
  const box = boxScore(plays, 'US');
  const mineRows = attacking ? box.offense : box.defense;

  if (attacking) {
    const pass = mineRows.filter((r) => r.att > 0);
    const rush = mineRows.filter((r) => r.car > 0);
    const rec = mineRows.filter((r) => r.tgt > 0);
    if (pass.length) pane.append(section('Passing', table(['', 'C/A', 'Yds', 'TD', 'INT'],
      pass.map((r) => [nameCell(r), `${r.comp}/${r.att}`, `${r.passYds}`, `${r.passTD}`, `${r.int}`]))));
    if (rush.length) pane.append(section('Rushing', table(['', 'Car', 'Yds', 'Avg', 'TD', 'Lng'],
      rush.map((r) => [nameCell(r), `${r.car}`, `${r.rushYds}`,
        num(r.rushYds / r.car), `${r.rushTD}`, `${r.rushLong}`]))));
    if (rec.length) pane.append(section('Receiving', table(['', 'Rec/Tgt', 'Yds', 'Avg', 'TD', 'Lng'],
      rec.map((r) => [nameCell(r), `${r.rec}/${r.tgt}`, `${r.recYds}`,
        num(r.rec ? r.recYds / r.rec : 0), `${r.recTD}`, `${r.recLong}`]))));
    if (!pass.length && !rush.length) pane.append(section('Box score', note('No offensive snaps yet.')));
  } else {
    pane.append(section('Defense', mineRows.length
      ? table(['', 'Tkl', 'Sack', 'PBU', 'INT'], mineRows.map((r) =>
          [nameCell(r), `${r.tkl}`, `${r.sacks}`, `${r.pbu}`, `${r.ints}`]))
      : note('No defensive snaps yet.')));
  }

  pane.insertAdjacentHTML('beforeend',
    `<p class="legend">Ratings move the needle about a third as much as calling the
     right concept against the right coverage. Over one game a box score is mostly
     variance — the matchup board above is the signal worth acting on.</p>`);
}

const nameCell = (r) => `<b class="jersey">${r.number ?? ''}</b>${r.pos} ${r.name} <em>${r.rating}</em>`;

document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => {
  document.querySelectorAll('.tab').forEach((x) => {
    const on = x === t;
    x.classList.toggle('is-on', on);
    x.setAttribute('aria-selected', String(on));
  });
  $('pane-feed').hidden = t.dataset.tab !== 'feed';
  $('pane-scout').hidden = t.dataset.tab !== 'scout';
  $('pane-players').hidden = t.dataset.tab !== 'players';
  if (app.t?.game) render(app.t.game, app.t.plays);
}));

function renderChirps(g) {
  const box = $('chirps');
  box.innerHTML = '';
  (g.chirps || []).slice(-4).forEach((c) => {
    box.append(el('div', 'chirp', `<b>${c.seat}</b> ${c.text}`));
  });
  const bar = $('chirp-bar');
  if (bar.childElementCount) return;
  CHIRPS.forEach((text) => {
    const c = el('button', 'chip', text);
    c.addEventListener('click', () => app.t.chirp(text, app.t.local ? seatOnClock(app.t.game.state) : app.t.mySeat));
    bar.append(c);
  });
}

/* ---------- pause, clock, modals ---------- */

$('btn-seat').addEventListener('click', () => {
  const cur = app.viewSeat || seatOnClock(app.t.game.state);
  app.viewSeat = cur === 'OC' ? 'DC' : 'OC';
  render(app.t.game, app.t.plays);
});

$('btn-pause').addEventListener('click', async () => {
  if (app.t.local) return app.t.pause();
  const reason = prompt('Tell your rival why (optional):') ?? '';
  try { await app.t.pause(reason); } catch (e) { flash(e.message); }
});

function managePause(g) {
  const p = g.pause || {};
  const me = app.t.mySeat;
  if (app.t.local) {
    if (g.status === 'paused') {
      modal(`<h2>Paused</h2><p>The clock is stopped. Come back whenever.</p>
        <div class="modal-actions"><button class="btn btn-primary" data-a="go">Resume</button></div>`,
        () => { app.t.pause(); closeModal(); });
    } else closeModal();
    return;
  }
  if (p.state === 'proposed' && p.by !== me) {
    modal(`<h2>Pause requested</h2><p>${p.by} wants to stop the clock.${p.reason ? ` "${p.reason}"` : ''}</p>
      <div class="modal-actions"><button class="btn btn-primary" data-a="yes">Pause the game</button>
      <button class="btn" data-a="no">Keep playing</button></div>`, (a) => {
      app.t.respond(a === 'yes'); closeModal();
    });
  } else if (g.status === 'paused' && !app.t.local) {
    modal(`<h2>Game paused</h2><p>Pick it up whenever you both come back. Nothing is lost.</p>
      <div class="modal-actions"><button class="btn btn-primary" data-a="ready">I'm back</button></div>`, () => {
      app.t.ready(true); closeModal();
    });
  } else if (p.state === 'proposed' && p.by === me) {
    modal(`<h2>Waiting on your rival</h2><p>They have to agree before the clock stops.</p>`);
  } else closeModal();
}

function managePlayClock(g) {
  clearInterval(app.tick);
  const cell = $('playcell');
  const out = $('playclock');
  const deadline = g.pending?.deadline;
  if (!deadline || g.status !== 'live') {
    out.innerHTML = '&ndash;&ndash;';
    cell.classList.remove('is-urgent');
    return;
  }
  const paint = () => {
    const left = Math.max(0, Math.round((deadline - Date.now()) / 1000));
    out.textContent = String(left).padStart(2, '0');
    cell.classList.toggle('is-urgent', left <= 10);
    if (left <= 0) clearInterval(app.tick);
  };
  paint();
  app.tick = setInterval(paint, 250);
}

function renderFinal(g, plays) {
  const s = g.state;
  const our = plays.filter((p) => p.possession === 'US' && p.offId);
  const their = plays.filter((p) => p.possession === 'CPU' && p.offId);
  const ypp = (arr) => arr.length ? (arr.reduce((a, p) => a + (p.outcome.yards || 0), 0) / arr.length).toFixed(2) : '—';
  const third = (arr) => {
    const a = arr.filter((p) => p.down === 3);
    return a.length ? Math.round(a.filter((p) => p.outcome.yards >= p.distance).length / a.length * 100) + '%' : '—';
  };
  const won = s.score.us > s.score.them;
  modal(`<h2>${abbr(g.teamName)} ${s.score.us} — ${s.score.them} ${abbr(g.oppName)}</h2>
    <p>${won ? 'A win goes on both your résumés. Only one of you gets the interview.' : 'A loss goes on both your résumés. The unit numbers are what separate you.'}</p>
    <div class="final-line"><span>Offense — yards per play</span><b>${ypp(our)}</b></div>
    <div class="final-line"><span>Offense — third down</span><b>${third(our)}</b></div>
    <div class="final-line"><span>Defense — yards allowed per play</span><b>${ypp(their)}</b></div>
    <div class="final-line"><span>Defense — third down allowed</span><b>${third(their)}</b></div>
    <div class="modal-actions" style="margin-top:1.25rem">
      <button class="btn btn-primary" data-a="again">${app.inSeason ? 'Back to the season' : 'Run it back'}</button>
    </div>`, () => {
    if (!app.inSeason) return location.reload();
    if (!link.local) {
      // The server owns the season; it reads the play log itself.
      closeModal();
      run(link.finish());
      return;
    }
    // Fold the result into the season in the same shape a simulated game
    // produces, then let the rest of the week play out.
    const res = statsFromPlays(plays, s, app.liveCfg);
    res.week = app.season.week;
    res.playoff = app.season.phase === 'playoffs';
    app.season = { ...app.season, results: [...app.season.results, res] };
    app.season = simRemainingWeek(app.season);
    closeModal();
    app.t = null; app.liveCfg = null;
    openSeason();
  });
}

function modal(html, cb) {
  const v = $('veil'), m = $('modal');
  if (v.dataset.html === html) return;
  v.dataset.html = html; v.hidden = false; m.innerHTML = html;
  m.querySelectorAll('[data-a]').forEach((b) => b.addEventListener('click', () => cb && cb(b.dataset.a)));
}
function closeModal() { $('veil').hidden = true; $('veil').dataset.html = ''; }

document.querySelectorAll('#tempo-row .chip').forEach((c) => c.addEventListener('click', () => {
  const g = app.t.game;
  app.t.plan('OC', { ...(g.gameplan?.OC || {}), tempo: c.dataset.tempo });
}));

/** A toast, not a chirp: the chirp column only exists on the game screen, so
    errors raised during a season or the offseason went unseen. */
function flash(msg) {
  let host = document.getElementById('toasts');
  if (!host) {
    host = el('div', 'toasts');
    host.id = 'toasts';
    document.body.append(host);
  }
  const t = el('div', 'toast', String(msg));
  host.append(t);
  setTimeout(() => t.classList.add('go'), 4200);
  setTimeout(() => t.remove(), 4800);
}
