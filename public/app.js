import { OFFENSE, DEFENSE, OFF_BY_ID, DEF_BY_ID } from './shared/playbook.js';
import { newGameState, emptyTendencies, fieldGoalProb, readTendencies, distBucket } from './shared/engine.js';
import { runToNextDecision, seatOnClock, keyRead, PLAY_CLOCK_MS, FILM_COST } from './shared/gameflow.js';

const API_URL = '/api';   // Netlify function; see netlify.toml

const $ = (id) => document.getElementById(id);
const el = (tag, cls, html) => { const n = document.createElement(tag); if (cls) n.className = cls; if (html != null) n.innerHTML = html; return n; };
const abbr = (s) => s.slice(0, 3).toUpperCase();
const mmss = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
const ORD = { 1: '1ST', 2: '2ND', 3: '3RD', 4: '4TH', 5: 'OT' };

/* ============================================================ transports
   Both expose the same surface, so the UI never knows which is running. */

class LocalTransport {
  constructor() { this.plays = []; this.listeners = []; this.local = true; }
  emit() { this.listeners.forEach((f) => f(this.game, this.plays)); }
  subscribe(f) { this.listeners.push(f); if (this.game) f(this.game, this.plays); }

  async create({ name, seat, teamName = 'Cascade', oppName = 'Ironworks' }) {
    this.gameId = 'local-' + Math.random().toString(36).slice(2, 8);
    this.game = {
      id: this.gameId, status: 'live', teamName, oppName,
      seats: { OC: { displayName: 'Offense', ready: true }, DC: { displayName: 'Defense', ready: true } },
      state: newGameState({ firstPossession: Math.random() < 0.5 ? 'US' : 'CPU' }),
      tendencies: { US: emptyTendencies(), CPU: emptyTendencies() },
      gameplan: { OC: { aggression: 0, tempo: 'normal' }, DC: { aggression: 0, tempo: 'normal' } },
      filmPoints: { OC: 0, DC: 0 }, pending: {}, pause: { state: 'none' }, chirps: [],
    };
    this.mySeat = seat;
    this.emit();
    return { gameId: this.gameId, seat };
  }
  async call({ callId, special }) {
    const r = runToNextDecision(this.gameId, this.game, { callId, special });
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
    await app.t.create({ seat: app.seat, displayName: app.name });
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
    app.t = new FirebaseTransport(fb);
    await app.t.join(code, app.name);
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
  ['setup', 'lobby', 'game'].forEach((s) => { $(s).hidden = s !== id; });
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
  const mine = app.t.local ? (app.viewSeat || seatOnClock(s)) : app.t.mySeat;
  const onClock = seatOnClock(s);
  const isMyCall = mine === onClock && g.status === 'live';

  renderStrip(g, s);
  renderField(g, s, plays || []);
  renderFeed(g, plays || []);
  renderChirps(g);

  const seatBtn = $('btn-seat');
  seatBtn.hidden = !app.t.local;
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

function renderStrip(g, s) {
  $('us-name').textContent = abbr(g.teamName);
  $('them-name').textContent = abbr(g.oppName);
  $('us-score').textContent = s.score.us;
  $('them-score').textContent = s.score.them;
  $('qtr').textContent = ORD[s.quarter] || 'OT';
  $('clock').textContent = mmss(s.clock);
  $('dnd').textContent = `${ORD[s.down]} & ${s.distance >= 100 - s.ballOn ? 'GOAL' : s.distance}`;
  const side = s.possession === 'US' ? g.teamName : g.oppName;
  $('spot').textContent = s.ballOn === 50 ? 'MIDFIELD'
    : s.ballOn < 50 ? `${abbr(side)} ${s.ballOn}` : `${abbr(s.possession === 'US' ? g.oppName : g.teamName)} ${100 - s.ballOn}`;
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
      parts.push(`<path d="M ${x1} ${VH / 2} Q ${mid} ${VH / 2 - lift} ${x2} ${VH / 2}" class="trace${kick ? ' kick' : ''}${miss}"/>`);
      if (!kick) {
        const head = x2 > x1 ? 1 : -1;
        parts.push(`<path d="M ${x2} ${VH / 2} l ${-2.2 * head} -1.5 l 0.5 1.5 l -0.5 1.5 z" class="tracehead"/>`);
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
    const b = el('button', 'call', `<b>${name}</b><span>${tag}</span>`);
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
    for (const grp of OFF_GROUPS) {
      const box = el('div', 'group', `<h3>${grp.title}</h3>`);
      OFFENSE.filter(grp.has).forEach((p) => box.append(mk(p.id, p.name, `${p.pers} · ${p.tag}`, commit({ callId: p.id }))));
      sheet.append(box);
    }
  } else {
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

const aggLabel = (v) => v <= -0.75 ? 'Ball control' : v < 0 ? 'Careful' : v === 0 ? 'Balanced' : v < 0.75 ? 'Attacking' : 'Reckless';

function renderFeed(g, plays) {
  const last = plays[plays.length - 1];
  const box = $('lastplay');
  if (last && last.outcome) {
    box.hidden = false;
    const o = last.outcome;
    const off = last.offId ? OFF_BY_ID[last.offId]?.name : (last.special ? 'Special teams' : '');
    const def = last.defId ? DEF_BY_ID[last.defId]?.name : '';
    const ours = last.possession === 'US';
    box.innerHTML = `<div class="matchup">${ours ? off : `<i>${off}</i>`} ${def ? 'vs' : ''} ${ours ? `<i>${def}</i>` : def}</div>
      <div class="result">${o.desc || ''}</div>`;
    if (o.readEdge < -0.02) box.append(el('div', 'tell', 'They read it. You have shown that look too often here.'));
    if (o.predictionHit) box.append(el('div', 'tell', `Read confirmed: ${o.predictionActual}. +1 film point.`));
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
      `<span class="t">Q${p.quarter} ${mmss(p.clock)}</span><span>${o.desc || ''}${
        (p.events || []).filter((e) => e.type === 'score' || e.type === 'period').map((e) => ' ' + e.text).join('')}</span>`);
    feed.append(li);
  }
}

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
  const bar = $('playclock');
  const fill = $('playclock-fill');
  const deadline = g.pending?.deadline;
  if (!deadline || g.status !== 'live') { fill.style.transform = 'scaleX(1)'; bar.classList.remove('is-urgent'); return; }
  const paint = () => {
    const left = Math.max(0, deadline - Date.now());
    fill.style.transform = `scaleX(${left / PLAY_CLOCK_MS})`;
    bar.classList.toggle('is-urgent', left < 10000);
    if (left <= 0) clearInterval(app.tick);
  };
  paint();
  app.tick = setInterval(paint, 1000);
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
      <button class="btn btn-primary" data-a="again">Run it back</button></div>`, () => location.reload());
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

function flash(msg) {
  const n = el('div', 'chirp', `<b>!</b> ${msg}`);
  $('chirps').prepend(n);
  setTimeout(() => n.remove(), 4000);
}
