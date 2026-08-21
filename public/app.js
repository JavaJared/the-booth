import { OFFENSE, DEFENSE, OFF_BY_ID, DEF_BY_ID } from './shared/playbook.js';
import { computeEdge, newGameState, emptyTendencies, fieldGoalProb, readTendencies, distBucket } from './shared/engine.js';
import { callRecord, opponentReport, shellReport, selfScout, unitSummary, isSuccess, boxScore } from './shared/scout.js';
import { makeRosters, matchupBoard, bySpot } from './shared/roster.js';
import { advanceWeek, simRemainingWeek, userGame, nextUserGame, record as seasonRecord,
  liveConfig, statsFromPlays, resume, weekLabel, weekGames, REGULAR_WEEKS,
  hydrate, dehydrate, startOffseason, recordInterview, interviewsLeft, canReady,
  useScout, toggleBoard, signFreeAgent, startDraft, advocate, runPicks,
  onTheClock, isOurPick, ADVOCACY, BOARD_MAX, SCOUT_POINTS, ROUNDS, careerResume,
  setOffseasonReady, advanceOffseason, bothReady, nextSeason,
  interviewQuestions, recordGameFilm, unlockFilmOverlay } from './shared/season.js';
import { resumeScore, archetypeOf } from './shared/carousel.js';
import { POSITION_GROUPS, DRILL_LABEL, gradeRank } from './shared/draft.js';
import { depthChart, rosterNeeds, unitSummary as rosterUnit } from './shared/depth.js';
import { seasonAwards } from './shared/awards.js';
import { FORMATIONS, FIELD_W, derivePlay, validate, describeRoute,
  OL_SPOTS, runSpots, DEF_ALIGN, deriveRun, deriveDefense, readRun, readDefense } from './shared/designer.js';
import { registerCustomPlays, registerCustomDefenses } from './shared/playbook.js';
import { TEAMS, TEAM_BY_ID, DIVISIONS, fullName, sortedStandings } from './shared/league.js';
import { runToNextDecision, seatOnClock, keyRead, PLAY_CLOCK_MS, FILM_COST } from './shared/gameflow.js';
import {
  FILM_GAME_GRANT, FILM_OVERLAY_COST, FILM_SITUATIONS, filmRows,
  opponentDiagram, opponentDefenseDiagram,
} from './shared/film.js';

const API_URL = '/api';   // Netlify function; see netlify.toml

const $ = (id) => document.getElementById(id);
const el = (tag, cls, html) => { const n = document.createElement(tag); if (cls) n.className = cls; if (html != null) n.innerHTML = html; return n; };
const abbr = (s) => s.slice(0, 3).toUpperCase();
const escapeHtml = (s) => String(s).replace(/[&<>'"]/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
}[c]));

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

  async create({ name, seat, teamName = 'Cascade', oppName = 'Ironworks',
    usRecord, themRecord, rosters, firstPossession, autoSeat,
    seasonSeed, cpuIdentity, us, them }) {
    this.gameId = 'local-' + Math.random().toString(36).slice(2, 8);
    this.game = {
      id: this.gameId, status: 'live', teamName, oppName, usRecord, themRecord,
      rosterSeed: Math.random().toString(36).slice(2, 12),
      rosters,
      seasonSeed, cpuIdentity, us, them,
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
  async call({ callId, special, auto, conversion, timeout }) {
    const r = runToNextDecision(this.gameId, this.game,
      { callId, special, auto, conversion, timeout });
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
  constructor(fb) {
    Object.assign(this, fb);
    this.plays = [];
    this.playById = new Map();
    this.listeners = [];
    this.unsubs = [];
    this.emitFrame = null;
    this.local = false;
  }
  subscribe(f) { this.listeners.push(f); if (this.game) f(this.game, this.plays); }
  emit() { this.listeners.forEach((f) => f(this.game, this.plays)); }
  queueEmit() {
    if (this.emitFrame != null) return;
    this.emitFrame = requestAnimationFrame(() => {
      this.emitFrame = null;
      this.emit();
    });
  }
  mergePlays(plays) {
    for (const p of plays || []) this.playById.set(String(p.playIndex), p);
    this.plays = [...this.playById.values()].sort((a, b) => a.playIndex - b.playIndex);
  }
  applyCallResult(result) {
    if (!result?.game) return;
    // A rival's newer snapshot may beat this response back to the browser.
    // Never replace it with an older state from our completed request.
    const currentIndex = this.game?.state?.playIndex ?? -1;
    const resultIndex = result.game.state?.playIndex ?? -1;
    if (resultIndex >= currentIndex) this.game = result.game;
    this.mergePlays(result.plays);
    this.queueEmit();
  }
  stop() {
    for (const unsub of this.unsubs) unsub();
    this.unsubs = [];
    if (this.emitFrame != null) cancelAnimationFrame(this.emitFrame);
    this.emitFrame = null;
  }

  watch(gameId) {
    this.stop();
    this.gameId = gameId;
    const { onSnapshot, doc, collection, query, orderBy, db } = this;
    this.playById.clear();
    this.plays = [];
    this.unsubs.push(
      onSnapshot(doc(db, 'games', gameId), (s) => { this.game = s.data(); this.queueEmit(); }),
      onSnapshot(query(collection(db, 'games', gameId, 'plays'), orderBy('playIndex')), (s) => {
        for (const change of s.docChanges()) {
          if (change.type === 'removed') this.playById.delete(change.doc.id);
          else this.playById.set(change.doc.id, change.doc.data());
        }
        this.plays = [...this.playById.values()].sort((a, b) => a.playIndex - b.playIndex);
        this.queueEmit();
      }),
    );
  }
  async create(opts) { const r = await this.fn('createGame')(opts); this.mySeat = r.data.seat; this.watch(r.data.gameId); return r.data; }
  async join(gameId, displayName) { const r = await this.fn('joinGame')({ gameId, displayName }); this.mySeat = r.data.seat; this.watch(gameId); return r.data; }
  async ready(ready) { return this.fn('setReady')({ gameId: this.gameId, ready }); }
  async call({ callId, special, auto, conversion, timeout }) {
    const response = await this.fn('submitCall')({ gameId: this.gameId, playIndex: this.game.state.playIndex,
      callId, special, auto, conversion, timeout });
    this.applyCallResult(response.data);
    return response.data;
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
  t: null, seat: 'OC', name: '', user: null, seasonUnsub: null,
  viewSeat: null, picked: null, busy: false, tick: null,
};

/* ---------- setup ---------- */
document.querySelectorAll('.seat-btn').forEach((b) => b.addEventListener('click', () => {
  document.querySelectorAll('.seat-btn').forEach((x) => { x.classList.remove('is-on'); x.setAttribute('aria-checked', 'false'); });
  b.classList.add('is-on'); b.setAttribute('aria-checked', 'true');
  app.seat = b.dataset.seat;
}));

const setupErr = (m) => { if ($('setup-err')) $('setup-err').textContent = m || ''; };
const guestErr = (m) => { $('guest-err').textContent = m || ''; };
const authErr = (m) => { $('auth-err').textContent = m || ''; };
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
    app.name = app.user?.displayName || app.user?.email?.split('@')[0] || nameVal();
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
    app.name = app.user?.displayName || app.user?.email?.split('@')[0] || nameVal();
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

$('btn-guest-join').addEventListener('click', async () => {
  guestErr('');
  const code = $('guest-join-code').value.trim();
  if (!code) return guestErr('Enter the exhibition code your rival sent you.');
  try {
    const fb = await connectFirebase({ anonymous: true });
    app.name = nameVal();
    app.t = new FirebaseTransport(fb);
    await app.t.join(code, app.name);
    rememberGame(code, app.name);
    app.t.subscribe(render);
    show('lobby');
  } catch (e) { guestErr(e.message.replace(/^.*?: /, '')); }
});

$('btn-ready').addEventListener('click', () => app.t.ready(true));

let _firebaseClient = null;
async function firebaseClient() {
  if (_firebaseClient) return _firebaseClient;
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

  _firebaseClient = { fbApp, a, auth, fs };
  return _firebaseClient;
}

async function connectFirebase({ anonymous = false } = {}) {
  const { fbApp, a, auth, fs } = await firebaseClient();
  if (!a.currentUser && anonymous) await auth.signInAnonymously(a);
  if (!a.currentUser) throw new Error('Log in to continue.');

  // Reads come straight from Firestore (realtime, and the rules make them
  // read-only). Every write goes through the serverless API, which is the only
  // thing holding admin credentials.
  const call = async (action, data) => {
    const started = performance.now();
    const token = await a.currentUser.getIdToken();
    const res = await fetch(API_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ action, data }),
    });
    const totalMs = performance.now() - started;
    const timing = {
      action,
      totalMs: Math.round(totalMs * 10) / 10,
      serverTiming: res.headers.get('server-timing') || '',
      at: Date.now(),
    };
    window.__boothTimings = [...(window.__boothTimings || []).slice(-49), timing];
    if (totalMs >= 750) console.info('[The Booth] slow request', timing);
    const body = await res.json().catch(() => ({ error: 'Server did not respond.' }));
    if (!res.ok) throw new Error(body.error || `Request failed (${res.status}).`);
    return body;
  };

  return {
    auth: a, authApi: auth, user: a.currentUser,
    db: fs.getFirestore(fbApp),
    onSnapshot: fs.onSnapshot, doc: fs.doc, collection: fs.collection,
    query: fs.query, orderBy: fs.orderBy,
    fn: (name) => (data) => call(name, data),
  };
}

function homeView(which) {
  $('auth-view').hidden = which !== 'auth';
  $('account-view').hidden = which !== 'account';
  $('guest-view').hidden = which !== 'guest';
}

const authMessage = (e) => ({
  'auth/invalid-credential': 'That email or password is not correct.',
  'auth/email-already-in-use': 'An account already uses that email.',
  'auth/weak-password': 'Use a password with at least 6 characters.',
  'auth/invalid-email': 'Enter a valid email address.',
  'auth/too-many-requests': 'Too many attempts. Wait a moment and try again.',
}[e.code] || e.message || 'Sign-in failed.');

async function refreshSeasonSlots() {
  const host = $('season-slots');
  host.innerHTML = '<div class="season-slot-empty">Loading your seasons…</div>';
  try {
    const { seasons, maxSlots = 5 } = await api('listMySeasons', {});
    host.innerHTML = '';
    $('slot-count').textContent = `${seasons.length} / ${maxSlots}`;
    $('btn-season').disabled = seasons.length >= maxSlots;
    $('btn-season').textContent = seasons.length ? 'Start New Season' : 'Start a New Season';
    renderLegacyMigration(seasons, maxSlots);
    if (!seasons.length) {
      host.append(el('div', 'season-slot-empty', 'No active season yet. Your first headset is waiting.'));
      return;
    }
    seasons.forEach((slot) => {
      const box = el('article', 'season-slot');
      const copy = el('div');
      const title = el('h3');
      title.textContent = slot.slotName;
      const rec = slot.record || { w: 0, l: 0, t: 0 };
      const meta = el('p');
      meta.textContent = `${slot.teamName} · ${slot.seat} · ${slot.weekLabel} · `
        + `${rec.w}-${rec.l}${rec.t ? `-${rec.t}` : ''}`;
      copy.append(title, meta);
      const actions = el('div', 'slot-actions');
      const resumeBtn = el('button', 'btn btn-primary btn-tiny', 'Resume Season');
      resumeBtn.addEventListener('click', () => resumeAccountSeason(slot.id));
      const retireBtn = el('button', 'btn btn-tiny', 'Retire');
      retireBtn.addEventListener('click', () => retireSeasonSlot(slot));
      actions.append(resumeBtn, retireBtn);
      box.append(copy, actions);
      host.append(box);
    });
  } catch (e) {
    host.innerHTML = '';
    const msg = el('div', 'season-slot-empty');
    msg.textContent = e.message;
    host.append(msg);
  }
}

function renderLegacyMigration(seasons, maxSlots) {
  const host = $('legacy-migration');
  const saved = loadSeason();
  if (!saved?.season) { host.hidden = true; host.innerHTML = ''; return; }

  host.hidden = false;
  host.innerHTML = '';
  const imported = saved.migrationId
    ? seasons.find((slot) => slot.legacyImportId === saved.migrationId) : null;
  const title = el('h3');
  const copy = el('p');
  const actions = el('div', 'slot-actions');

  if (imported) {
    title.textContent = 'Device save imported';
    copy.textContent = `${imported.slotName} is safely stored in your account. `
      + 'The original device copy is still available as a backup.';
    const resume = el('button', 'btn btn-primary btn-tiny', 'Resume Imported Season');
    resume.addEventListener('click', () => resumeAccountSeason(imported.id));
    const remove = el('button', 'btn btn-tiny', 'Remove Device Backup');
    remove.addEventListener('click', removeLegacyBackup);
    actions.append(resume, remove);
  } else {
    const team = TEAM_BY_ID[saved.season.userTeam];
    title.textContent = 'Season found on this device';
    copy.textContent = `${team ? `${team.city} ${team.name}` : 'Legacy season'} · `
      + `${weekLabel(saved.season.week || 1)}. Import it to use this save on any device.`;
    const migrate = el('button', 'btn btn-primary btn-tiny', 'Import Existing Season');
    migrate.disabled = seasons.length >= maxSlots;
    migrate.addEventListener('click', () => importLegacySeason(saved));
    actions.append(migrate);
    if (migrate.disabled) {
      actions.append(el('span', 'account-email', 'Retire a slot before importing.'));
    }
  }
  host.append(title, copy, actions);
}

async function importLegacySeason(saved) {
  setupErr('');
  try {
    if (!saved.migrationId) {
      saved.migrationId = globalThis.crypto?.randomUUID?.()
        || `legacy-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      localStorage.setItem(SAVE_KEY, JSON.stringify(saved));
    }
    const slotName = `${TEAM_BY_ID[saved.season.userTeam]?.name || 'Team'} career (imported)`;
    const result = await api('importLocalSeason', {
      season: saved.season,
      seat: saved.seat || 'OC',
      displayName: app.name,
      slotName,
      migrationId: saved.migrationId,
    });
    // Verify through the same account listing used on another device before
    // telling the user that the migration is safe.
    const check = await api('listMySeasons', {});
    const verified = check.seasons.find((slot) => slot.id === result.seasonId
      && slot.legacyImportId === saved.migrationId);
    if (!verified) throw new Error('The server received the save, but verification did not complete. Your device copy is unchanged.');
    await refreshSeasonSlots();
  } catch (e) { setupErr(e.message); }
}

function removeLegacyBackup() {
  modal(`<h2>Remove the device backup?</h2><p>The imported account save will stay in
    Firestore and work across devices. Only this browser's old copy will be removed.</p>
    <div class="modal-actions"><button class="btn btn-primary" data-a="keep">Keep backup</button>
    <button class="btn" data-a="remove">Remove backup</button></div>`, async (act) => {
    closeModal();
    if (act !== 'remove') return;
    clearSeason();
    await refreshSeasonSlots();
  });
}

async function resumeAccountSeason(seasonId) {
  setupErr('');
  try {
    const fb = await connectFirebase();
    app.name = app.user?.displayName || app.user?.email?.split('@')[0] || 'Coordinator';
    const r = await fb.fn('joinSeason')({ seasonId, displayName: app.name });
    watchSeason(fb, seasonId, r.data.seat);
  } catch (e) { setupErr(e.message); }
}

function retireSeasonSlot(slot) {
  modal(`<h2>Retire this save?</h2><p>${escapeHtml(slot.slotName)} will leave your active save slots.
    A rival sharing the season keeps their own copy.</p><div class="modal-actions">
    <button class="btn btn-primary" data-a="keep">Keep it</button>
    <button class="btn" data-a="retire">Retire save</button></div>`, async (act) => {
    closeModal();
    if (act !== 'retire') return;
    try { await api('archiveSeason', { seasonId: slot.id }); await refreshSeasonSlots(); }
    catch (e) { setupErr(e.message); }
  });
}

$('btn-login').addEventListener('click', async () => {
  authErr('');
  try {
    const { a, auth } = await firebaseClient();
    if (a.currentUser?.isAnonymous) await auth.signOut(a);
    await auth.signInWithEmailAndPassword(a, $('auth-email').value.trim(), $('auth-password').value);
  } catch (e) { authErr(authMessage(e)); }
});

$('btn-signup').addEventListener('click', async () => {
  authErr('');
  try {
    const { a, auth } = await firebaseClient();
    if (a.currentUser?.isAnonymous) await auth.signOut(a);
    const made = await auth.createUserWithEmailAndPassword(
      a, $('auth-email').value.trim(), $('auth-password').value);
    const displayName = made.user.email.split('@')[0];
    await auth.updateProfile(made.user, { displayName });
    app.user = made.user;
    app.name = displayName;
    homeView('account');
    await refreshSeasonSlots();
  } catch (e) { authErr(authMessage(e)); }
});

$('btn-logout').addEventListener('click', async () => {
  const { a, auth } = await firebaseClient();
  if (app.seasonUnsub) { app.seasonUnsub(); app.seasonUnsub = null; }
  await auth.signOut(a);
  app.user = null;
  homeView('auth');
  show('setup');
});

$('btn-guest').addEventListener('click', async () => {
  authErr('');
  try { await connectFirebase({ anonymous: true }); homeView('guest'); offerRejoin(); }
  catch (e) { authErr(e.message); }
});
$('btn-account-exhibition').addEventListener('click', () => homeView('guest'));
$('btn-back-login').addEventListener('click', () => homeView(app.user ? 'account' : 'auth'));

async function initAccountHome() {
  try {
    const { a, auth } = await firebaseClient();
    auth.onAuthStateChanged(a, async (user) => {
      if (!user || user.isAnonymous) {
        app.user = null;
        homeView('auth');
        return;
      }
      app.user = user;
      app.name = user.displayName || user.email?.split('@')[0] || 'Coordinator';
      $('account-name').textContent = `Welcome, ${app.name}`;
      $('account-email').textContent = user.email || '';
      homeView('account');
      await refreshSeasonSlots();
    });
  } catch (e) { authErr(e.message); }
}
initAccountHome();

function show(id) {
  ['setup', 'lobby', 'season', 'designer', 'game'].forEach((s) => { $(s).hidden = s !== id; });
}

/* ============================================================ play designer
   A coordinator does not label a play; the routes decide what it is. The read
   panel updates as you draw, so you can see a concept form. */

const DZ = { mode: 'pass', pers: '11', sel: null, routes: {}, pa: false,
  carrier: [], carrierSpot: 'RB1', blocks: {}, blockers: [], dpos: {}, paths: {}, man: false,
  overlay: null, filmCallId: '' };
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

function designerFilmContext() {
  if (!['OC', 'DC'].includes(app.seat) || !app.season) return null;
  const game = nextUserGame(app.season);
  if (!game) return null;
  const teamId = game.home === app.season.userTeam ? game.away : game.home;
  return { teamId, name: fullName(teamId), unit: app.seat === 'DC' ? 'offense' : 'defense' };
}

function overlayDiagram(overlay = DZ.overlay) {
  if (!overlay) return null;
  return overlay.unit === 'defense' ? opponentDefenseDiagram(overlay.callId)
    : opponentDiagram(overlay.callId);
}

function renderDesignerFilmControls() {
  const box = $('dz-film-controls');
  const context = designerFilmContext();
  box.hidden = !context;
  if (!context) return;

  const source = context.unit === 'offense' ? OFFENSE : DEFENSE;
  const diagram = context.unit === 'offense' ? opponentDiagram : opponentDefenseDiagram;
  const plays = source.filter((p) => !p.custom && diagram(p.id));
  const valid = new Set(plays.map((p) => p.id));
  if (DZ.overlay?.teamId === context.teamId) DZ.filmCallId = DZ.overlay.callId;
  if (!valid.has(DZ.filmCallId)) DZ.filmCallId = '';

  $('dz-film-label').textContent = `${context.name} ${context.unit === 'offense' ? 'offensive' : 'defensive'} overlay`;
  $('dz-film-select').innerHTML = '<option value="">Select an opponent play</option>'
    + [...new Set(plays.map((p) => p.family))].map((family) => {
      const label = context.unit === 'defense' ? (family || 'Defensive calls')
        : family === 'run' ? 'Runs' : family === 'quick' ? 'Quick game'
          : family === 'screen' ? 'Screens' : family === 'dropback' ? 'Dropback passes'
            : family === 'playaction' ? 'Play action' : 'Deep shots';
      const options = plays.filter((p) => p.family === family).map((p) =>
        `<option value="${p.id}">${p.name} &middot; ${p.pers}${context.unit === 'offense' ? ' personnel' : ''}</option>`).join('');
      return `<optgroup label="${label}">${options}</optgroup>`;
    }).join('');
  $('dz-film-select').value = DZ.filmCallId;

  const balance = app.season.filmBank?.[app.seat] || 0;
  const unlocked = new Set(app.season.filmOverlays?.[app.seat] || []);
  const key = DZ.filmCallId && `${context.teamId}:${DZ.filmCallId}`;
  const owns = key && unlocked.has(key);
  const action = $('dz-film-action');
  action.textContent = !DZ.filmCallId ? 'Select a play'
    : owns ? (DZ.overlay?.callId === DZ.filmCallId && DZ.overlay?.teamId === context.teamId
      ? 'Overlay active' : 'Show overlay')
      : `Unlock overlay · ${FILM_OVERLAY_COST} film`;
  action.disabled = !DZ.filmCallId || (!owns && balance < FILM_OVERLAY_COST);
  $('dz-film-balance').textContent = `${balance} film available`;
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
  const overlay = overlayDiagram();
  $('dz-overlay-note').hidden = !overlay;
  if (overlay) {
    $('dz-overlay-label').innerHTML = `<b>Opponent film:</b> ${overlay.play.name} &middot; ${overlay.play.pers}`;
  }
  const sel = $('dz-pers');
  sel.innerHTML = Object.entries(FORMATIONS)
    .map(([k, v]) => `<option value="${k}">${k} personnel &mdash; ${v.label}</option>`).join('');
  sel.value = DZ.pers;
  renderDesignerFilmControls();
  show('designer');
  drawDesigner();
}

function appendFilmOverlaySvg(parts) {
  const overlay = overlayDiagram();
  if (!overlay) return;
  for (const [spot, pts] of Object.entries(overlay.paths)) {
    if (!pts || pts.length < 2) continue;
    const svgPts = pts.map((q) => [fx(q[0]), fy(q[1])]);
    const tip = svgPts[svgPts.length - 1], prev = svgPts[svgPts.length - 2];
    const { base, points } = arrow(prev, tip, 1.5, 0.7);
    const line = [...svgPts.slice(0, -1), base];
    parts.push(`<path d="${line.map((q, i) => `${i ? 'L' : 'M'} ${q[0].toFixed(2)} ${q[1].toFixed(2)}`).join(' ')}" class="dz-film-route"/>`);
    parts.push(`<polygon points="${points}" class="dz-film-arrow"/>`);
    const start = svgPts[0];
    parts.push(`<circle cx="${start[0]}" cy="${start[1]}" r="1.15" class="dz-film-spot"/>`);
    parts.push(`<text x="${start[0]}" y="${start[1] - 2.1}" class="dz-film-label">${spot}</text>`);
  }
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
  appendFilmOverlaySvg(p);

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
  appendFilmOverlaySvg(p);
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
  const film = overlayDiagram();
  const matchup = film?.play?.cov ? computeEdge(play, film.play) : null;
  const c = play.structure;
  const covs = [['man1', 'Man'], ['cover2', 'Cover 2'], ['tampa2', 'Tampa 2'],
    ['cover3', 'Cover 3'], ['quarters', 'Quarters']];
  const best = covs.reduce((a, b) => (play.vs[a[0]] > play.vs[b[0]] ? a : b));
  box.innerHTML = `<p class="dz-tag">${play.tag}</p>`
    + `<p class="scout-note" style="padding:0">Best against <b>${best[1]}</b>.</p>`
    + (film?.play?.cov ? `<div class="dz-read"><h4>Film matchup</h4></div>${table(['', ''], [
      ['Opponent call', film.play.name],
      ['Expected edge', matchup > 0.035 ? '<b class="gap good">Offense</b>'
        : matchup < -0.035 ? '<b class="gap bad">Defense</b>' : 'Even'],
    ])}` : '')
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
  const film = overlayDiagram();
  const matchup = film?.play?.cov ? computeEdge(play, film.play) : null;
  box.innerHTML = `<p class="dz-tag">${play.tag}</p>`
    + `<p class="scout-note" style="padding:0">Attacks ${play.edge === 'outside' ? 'the perimeter' : 'inside'}.</p>`
    + (film?.play?.cov ? `<div class="dz-read"><h4>Film matchup</h4></div>${table(['', ''], [
      ['Opponent call', film.play.name],
      ['Expected edge', matchup > 0.035 ? '<b class="gap good">Offense</b>'
        : matchup < -0.035 ? '<b class="gap bad">Defense</b>' : 'Even'],
    ])}` : '')
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
  const overlay = overlayDiagram();
  const matchup = overlay ? computeEdge(overlay.play, call) : null;
  $('dz-read').innerHTML = `<p class="dz-tag">${COV_LABEL[call.cov]}</p>`
    + `<p class="scout-note" style="padding:0">${call.tag || 'base look'}</p>`
    + (overlay ? `<div class="dz-read"><h4>Film matchup</h4></div>${table(['', ''], [
      ['Opponent call', overlay.play.name],
      ['Expected edge', matchup < -0.035 ? '<b class="gap good">Defense</b>'
        : matchup > 0.035 ? '<b class="gap bad">Offense</b>' : 'Even'],
    ])}` : '')
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
$('dz-overlay-clear').addEventListener('click', () => {
  DZ.overlay = null;
  $('dz-overlay-note').hidden = true;
  renderDesignerFilmControls();
  drawDesigner();
});
$('dz-film-select').addEventListener('change', (e) => {
  DZ.filmCallId = e.target.value;
  const context = designerFilmContext();
  const key = context && DZ.filmCallId && `${context.teamId}:${DZ.filmCallId}`;
  const unlocked = new Set(app.season?.filmOverlays?.[app.seat] || []);
  DZ.overlay = key && unlocked.has(key)
    ? { teamId: context.teamId, callId: DZ.filmCallId, unit: context.unit } : null;
  renderDesignerFilmControls();
  drawDesigner();
});
$('dz-film-action').addEventListener('click', async () => {
  const button = $('dz-film-action');
  const context = designerFilmContext();
  const callId = DZ.filmCallId;
  if (!context || !callId) return;
  const key = `${context.teamId}:${callId}`;
  const owns = (app.season.filmOverlays?.[app.seat] || []).includes(key);
  if (!owns) {
    button.disabled = true;
    button.classList.add('is-pending');
    button.setAttribute('aria-busy', 'true');
    button.textContent = 'Studying…';
    try {
      await link.unlockFilm(context.teamId, callId);
    } catch (e) {
      flash(e.message || 'That did not work.');
      renderDesignerFilmControls();
      return;
    } finally {
      button.classList.remove('is-pending');
      button.removeAttribute('aria-busy');
    }
  }
  DZ.overlay = { teamId: context.teamId, callId, unit: context.unit };
  openDesigner();
});
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
    run(link.install(play));
    DZ.carrier = []; DZ.blocks = {}; DZ.sel = null; DZ.carrierSpot = 'RB1';
    $('dz-name').value = '';
    flash(`${play.name} installed \u2014 ${play.tag}.`);
    return drawDesigner();
  }
  if (DZ.mode === 'def') {
    const d = defDesign();
    if (!d.name.trim()) return flash('Give the call a name.');
    const call = deriveDefense({ ...d, id: 'cd' + Math.random().toString(36).slice(2, 8) });
    run(link.install(call));
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
  run(link.install(play));
  DZ.routes = {}; DZ.sel = null;
  $('dz-name').value = '';
  flash(`${play.name} installed — ${play.tag}.`);
  drawDesigner();
});

/* ============================================================ season
   Local seasons live in this tab and survive a refresh. Losing seventeen
   weeks of work to an accidental reload would be unforgivable. */

const SAVE_KEY = 'booth:season';
const RECENT_SEASON_KEY = 'booth:recent-season';
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
function saveSeason() {
  try {
    // A shared season lives on the server. Writing a copy here meant that on
    // return the resume prompt loaded the stale local fork and quietly cut you
    // off from your rival — the save has to record the code, not the state.
    if (!link.local && app.seasonId) {
      localStorage.setItem(RECENT_SEASON_KEY, JSON.stringify({
        shared: true, seasonId: app.seasonId, seat: app.seat, name: app.name,
        team: app.season?.userTeam, week: app.season?.week, at: Date.now(),
      }));
      return;
    }
    localStorage.setItem(SAVE_KEY, JSON.stringify({
      season: app.season, seat: app.seat, at: Date.now(),
    }));
  } catch (e) { /* private browsing or quota — the season still works in memory */ }
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
function run(p, button = null, pendingText = 'Working…') {
  const pending = button instanceof HTMLButtonElement;
  const original = pending ? { html: button.innerHTML, disabled: button.disabled } : null;
  if (pending) {
    button.disabled = true;
    button.classList.add('is-pending');
    button.setAttribute('aria-busy', 'true');
    button.textContent = pendingText;
  }
  return Promise.resolve(p)
    .catch((e) => flash(e.message || 'That did not work.'))
    .finally(() => {
      if (!pending) return;
      button.innerHTML = original.html;
      button.disabled = original.disabled;
      button.classList.remove('is-pending');
      button.removeAttribute('aria-busy');
    });
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
    await api('advanceSeason', { seasonId: app.seasonId, ready: true });
  },
  async finish(gameId) {
    if (this.local) return;
    await api('finishWeek', { seasonId: app.seasonId, gameId });
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
  async board(prospectId) {
    if (this.local) { app.season = toggleBoard(app.season, app.seat, prospectId); renderSeason(); return; }
    await api('toggleBoard', { seasonId: app.seasonId, prospectId });
  },
  async unlockFilm(teamId, callId) {
    if (this.local) {
      const next = unlockFilmOverlay(app.season, app.seat, teamId, callId);
      if (next === app.season) throw new Error('That overlay is unavailable or you need more film.');
      app.season = next;
      renderSeason();
      return;
    }
    const result = await api('unlockFilmOverlay', { seasonId: app.seasonId, teamId, callId });
    // The Firestore listener remains authoritative, but reflecting the
    // successful transaction immediately lets the designer reveal the overlay
    // without waiting for the snapshot round trip.
    app.season = {
      ...app.season,
      filmBank: { ...app.season.filmBank, [app.seat]: result.balance },
      filmOverlays: {
        ...app.season.filmOverlays,
        [app.seat]: [...new Set([...(app.season.filmOverlays?.[app.seat] || []), result.key])],
      },
    };
    return result;
  },
  async advocate(prospectId, amount) {
    if (this.local) { app.season = advocate(app.season, app.seat, prospectId, amount); renderSeason(); return; }
    await api('advocate', { seasonId: app.seasonId, prospectId, amount });
  },
  /** A drawn play has to reach whoever resolves the snap. */
  async install(play) {
    registerCustomPlays(play.cov ? [] : [play]);
    if (play.cov) registerCustomDefenses([play]);
    if (this.local) {
      if (app.season) {
        const key = play.cov ? 'customDefenses' : 'customPlays';
        app.season = { ...app.season, [key]: [...(app.season[key] || []), play] };
        saveSeason();
      }
      return;
    }
    // In a shared season the server owns the document, so a play written only
    // to app.season is wiped by the next snapshot and the snap is rejected.
    await api('installPlay', { seasonId: app.seasonId, play });
  },
  async runPicks(makeOurs) {
    if (this.local) { app.season = runPicks(app.season, { makeOurs }); renderSeason(); return; }
    await api('runPicks', { seasonId: app.seasonId, makeOurs: !!makeOurs });
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
  if (app.seasonUnsub) app.seasonUnsub();
  app.seasonId = seasonId;
  app.seat = seat;
  link.local = false;
  app.inSeason = true;
  rememberSeasonCode(seasonId);
  let attached = null;
  app.seasonUnsub = fb.onSnapshot(fb.doc(fb.db, 'seasons', seasonId), (snap) => {
    const designerWasOpen = !$('designer').hidden;
    const doc = snap.data();
    if (!doc) return;
    app.seasonDoc = doc;
    app.season = hydrate(JSON.parse(JSON.stringify(doc)));
    // Register on every snapshot, not just on load: a play your rival installs
    // arrives here and the resolver needs to know about it too.
    registerCustomPlays(app.season.customPlays || []);
    registerCustomDefenses(app.season.customDefenses || []);

    if (doc.currentGameId && attached !== doc.currentGameId) {
      attached = doc.currentGameId;
      app.t?.stop?.();
      const t = new FirebaseTransport(fb);
      t.mySeat = seat;
      app.t = t;
      t.watch(doc.currentGameId);
      t.subscribe(render);
      show('game');
      return;
    }
    if (!doc.currentGameId) {
      attached = null;
      app.t?.stop?.();
      app.t = null;
      renderSeason();
      // Film unlocks update the season document. Preserve the workspace while
      // that snapshot refreshes the balance instead of treating every season
      // update like navigation back from a finished game.
      if (designerWasOpen) openDesigner();
      else show('season');
    }
  });
}

$('btn-home').addEventListener('click', async () => {
  if (app.seasonUnsub) { app.seasonUnsub(); app.seasonUnsub = null; }
  app.t?.stop?.();
  app.t = null;
  app.inSeason = false;
  show('setup');
  homeView('account');
  await refreshSeasonSlots();
});

$('btn-season').addEventListener('click', () => pickTeam());

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
    <label class="form-field"><span>Save slot name</span>
      <input id="slot-name" type="text" maxlength="40" placeholder="My coaching career"></label>
    <div class="modal-actions">
      <button class="btn btn-primary" data-a="OC">Coordinate the offense</button>
      <button class="btn btn-primary" data-a="DC">Coordinate the defense</button>
    </div>`, async (act) => {
    const team = document.getElementById('team-pick').value;
    const shared = document.getElementById('mode-pick').value === 'rival';
    const slotName = document.getElementById('slot-name').value.trim();
    app.seat = act;
    try {
      const fb = await connectFirebase();
      app.name = app.user?.displayName || app.user?.email?.split('@')[0] || 'Coordinator';
      const r = await fb.fn('createSeason')({
        seat: act, displayName: app.name, teamId: team, slotName,
      });
      closeModal();
      rememberSeasonCode(r.data.seasonId);
      watchSeason(fb, r.data.seasonId, r.data.seat);
      if (shared) showSeasonCode(r.data.seasonId);
    } catch (e) { setupErr(e.message); closeModal(); }
  });
}

function rememberSeasonCode(id) {
  try {
    localStorage.setItem(RECENT_SEASON_KEY, JSON.stringify({
      shared: true, seasonId: id, seat: app.seat, name: app.name,
      team: app.season?.userTeam, week: app.season?.week, at: Date.now(),
    }));
  } catch {}
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
  else ({ week: paneWeek, film: paneFilm, standings: paneStandings, roster: paneRoster,
    awards: paneAwards, resume: paneResume, bracket: paneBracket }[tab])(pane, S);
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
      call.addEventListener('click', () => run(link.vote('call'), call, 'Saving…'));
      const sim = el('button', 'btn' + (mine === 'sim' ? ' btn-primary' : ''), 'Let the staff handle it');
      sim.addEventListener('click', () => run(link.vote('sim'), sim, 'Saving…'));
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
    run(link.advance(), btn, S.phase === 'done' ? 'Opening Black Monday…' : 'Advancing…');
  });
  next.append(btn);
  if (!ready) next.append(el('p', 'scout-note', 'Play or sim your game first.'));
  pane.append(next);
}

function openOpponentFilm(teamId, callId) {
  const unit = app.seat === 'DC' ? 'offense' : 'defense';
  const diagram = unit === 'offense' ? opponentDiagram(callId) : opponentDefenseDiagram(callId);
  if (!diagram) return flash('That play has no diagram yet.');
  DZ.overlay = { teamId, callId, unit };
  DZ.filmCallId = callId;
  DZ.mode = app.seat === 'DC' ? 'def' : 'pass';
  DZ.sel = null;
  if (app.seat === 'DC') {
    DZ.paths = {};
    DZ.dpos = {};
    DZ.man = false;
  } else {
    DZ.routes = {};
    DZ.blocks = {};
    DZ.carrier = [];
  }
  $('dz-name').value = `Answer ${diagram.play.name}`;
  openDesigner();
}

function filmSituationTable(S, teamId, unit, situation, { previous = false } = {}) {
  let rows = filmRows(previous ? S.lastGameFilm?.book : S.filmBook,
    teamId, unit, situation.key);
  if (previous) {
    rows = [...rows].sort((a, b) => unit === 'offense'
      ? (b.ypp ?? -99) - (a.ypp ?? -99)
      : (a.ypp ?? 99) - (b.ypp ?? 99));
  }
  rows = rows.slice(0, 5);
  if (!rows.length) return null;
  const unlocked = new Set(S.filmOverlays?.[app.seat] || []);
  const balance = S.filmBank?.[app.seat] || 0;
  const cells = rows.map((row) => {
    const key = `${teamId}:${row.callId}`;
    let action = '';
    if ((app.seat === 'DC' && unit === 'offense') || (app.seat === 'OC' && unit === 'defense')) {
      action = unlocked.has(key)
        ? `<button class="btn btn-tiny" data-open-film="${row.callId}" data-film-team="${teamId}">Open overlay</button>`
        : `<button class="btn btn-tiny" data-buy-film="${row.callId}" data-film-team="${teamId}"${balance < FILM_OVERLAY_COST ? ' disabled' : ''}>Study &middot; ${FILM_OVERLAY_COST}</button>`;
    }
    const core = [row.name, `${Math.round(row.frequency * 100)}% <small>(${row.n})</small>`];
    return previous ? [...core,
      row.ypp == null ? '&mdash;' : row.ypp.toFixed(1),
      row.success == null ? '&mdash;' : `${Math.round(row.success * 100)}%`, action]
      : [...core, action];
  });
  const headings = previous
    ? ['Call', 'Freq', unit === 'offense' ? 'Yds/play' : 'Yds allowed', 'Success', '']
    : ['Call', 'Freq', ''];
  return `<section class="film-situation"><h4>${situation.label}</h4>${table(headings, cells)}</section>`;
}

function bindFilmActions(pane) {
  pane.querySelectorAll('[data-open-film]').forEach((b) => b.addEventListener('click', () =>
    openOpponentFilm(b.dataset.filmTeam, b.dataset.openFilm)));
  pane.querySelectorAll('[data-buy-film]').forEach((b) => b.addEventListener('click', () =>
    run(link.unlockFilm(b.dataset.filmTeam, b.dataset.buyFilm), b, 'Studying…')));
}

function paneFilm(pane, S) {
  const seat = app.seat;
  const unit = seat === 'DC' ? 'offense' : 'defense';
  const balance = S.filmBank?.[seat] || 0;
  pane.append(el('section', 'film-bank', seat === 'DC'
    ? `<div><span>Available film</span><b>${balance}</b></div>
      <p>Earn ${FILM_GAME_GRANT} after each game you call, plus unused live read points. Spend ${FILM_OVERLAY_COST}
      to put an opponent concept directly over the defensive play designer.</p>`
    : `<div><span>Available film</span><b>${balance}</b></div>
      <p>See which defensive calls gave your offense the most trouble. Spend ${FILM_OVERLAY_COST}
      to put an opponent defense directly over the offensive play designer.</p>`));

  const last = S.lastGameFilm;
  if (last?.opponent) {
    const blocks = FILM_SITUATIONS.map((s) =>
      filmSituationTable(S, last.opponent, unit, s, { previous: true })).filter(Boolean);
    pane.append(card(`Last game: what ${TEAM_BY_ID[last.opponent]?.name || 'the opponent'} used`,
      blocks.length
        ? `<p class="scout-note">${last.detailed
          ? (seat === 'DC' ? 'Ranked by the damage each offensive call did.'
            : 'Ranked by which defensive calls held your offense down.')
          : 'Your staff handled this game, so the call frequency is available without snap outcomes.'}</p>${blocks.join('')}`
        : note('No usable call film was recorded.')));
  } else {
    pane.append(card('Last game', note('Complete a game and its situational report will appear here.')));
  }

  const game = userGame(S);
  if (game) {
    const opponent = game.home === S.userTeam ? game.away : game.home;
    const blocks = FILM_SITUATIONS.map((s) =>
      filmSituationTable(S, opponent, unit, s)).filter(Boolean);
    pane.append(card(`Next opponent: ${fullName(opponent)}`,
      blocks.length
        ? `<p class="scout-note">Season-to-date calls, grouped by down and distance. Frequency is within that situation.</p>${blocks.join('')}`
        : note('There is not enough season film on this opponent yet.')));
  } else {
    pane.append(card('Next opponent', note('The next report appears when a matchup is scheduled.')));
  }
  bindFilmActions(pane);
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
    const b = el('button', 'btn btn-primary', 'Back to coaching office');
    b.addEventListener('click', () => $('btn-home').click());
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
    pane.append(careerCard(S, seat));
    pane.append(card('Black Monday',
      `<p class="scout-note">${c.openings.length
        ? `${c.openings.length} club${c.openings.length > 1 ? 's' : ''} changed head coach.`
        : 'Every club kept its coach. Brutal year to be looking.'}</p>`));
    pane.append(card('This season', table(['', ''], [
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
  } else if (stage === 'draft' && S.draftRoom) {
    // Only a finished room falls through to the ready-up controls; while the
    // draft is live, the pick button is the only way forward.
    if (!paneDraft(pane, S, seat)) return;
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
    scouting: 'Start the draft',
    draft: `Report for ${S.year + 1} training camp`,
  };
  const b = el('button', 'btn' + (iAmReady ? '' : ' btn-primary'), iAmReady ? 'Waiting…' : labels[stage]);
  b.disabled = !canReady(S, seat) || iAmReady;
  b.addEventListener('click', () => run(link.ready(true), b, 'Saving…'));
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
  const boarded = S.draftBoard?.[seat] || [];
  const view = (S.boardView?.[seat] || []).filter((p) => p.side === side);
  const groups = POSITION_GROUPS[side];
  if (!DZG.group) DZG.group = groups[0].key;

  // A meter rather than a sentence: this is the resource the whole stage is
  // about, and it needs to be readable without hunting for it.
  const meter = el('section', 'scout-meter');
  meter.innerHTML = `
    <div class="meter-big"><b>${left}</b><span>scouting points left</span></div>
    <div class="meter-bar"><i style="width:${(left / SCOUT_POINTS) * 100}%"></i></div>
    <div class="meter-side">
      <span><b>${boarded.length}</b> / ${BOARD_MAX} on your board</span>
      <span>Four points is everything anyone can know about a player.</span>
    </div>`;
  pane.append(meter);

  const tabs = el('div', 'tabs grp-tabs');
  for (const g of groups) {
    const n = view.filter((p) => g.pos.includes(p.pos)).length;
    const b = el('button', 'tab' + (DZG.group === g.key ? ' is-on' : ''), `${g.label} <i>${n}</i>`);
    b.addEventListener('click', () => { DZG.group = g.key; renderSeason(); });
    tabs.append(b);
  }
  pane.append(tabs);

  const group = groups.find((g) => g.key === DZG.group) || groups[0];
  // Ordered by where the class is projected to go, which is public and fixed.
  // Sorting by your own scouted grade would shuffle the list every time you
  // spent a point, and would give away a good report before you read it.
  const list = view.filter((p) => group.pos.includes(p.pos))
    .sort((a, b) => (a.projected || 999) - (b.projected || 999));

  // Late-round targets are the point of a deep board, so show the whole group.
  pane.append(el('p', 'scout-note',
    `${list.length} in this group, in projected draft order. `
    + 'Nobody moves on this list when you scout him \u2014 the consensus does not know what you know.'));
  const wrap = el('section', 'prospects');
  for (const p of list) {
    const on = boarded.includes(p.id);
    const card = el('article', 'prospect' + (on ? ' is-boarded' : '')
      + (p.scouted ? ' is-scouted' : ''));
    const traits = p.traits.map((t) => t.unknown
      ? `<span class="trait unknown"><b>${t.label}</b><u>?</u></span>`
      : `<span class="trait${t.measured ? ' measured' : ''}${p.exact ? ' exact' : ''}"><b>${t.label}</b><u>${
          t.low === t.high ? t.low : `${t.low}\u2013${t.high}`}</u></span>`).join('');
    const combine = p.combine
      ? `<div class="combine">${Object.entries(p.combine)
          .map(([k, v]) => `<span><b>${DRILL_LABEL[k]}</b> ${v}${k === 'bench' ? ' reps' : ''}</span>`).join('')}</div>`
      : `<p class="no-combine">Did not work out at the combine.</p>`;
    card.innerHTML = `
      <header>
        <div class="who">
          <span class="proj">R${p.projRound > ROUNDS ? 'FA' : p.projRound}
            <u>#${p.projected}</u></span>
          <div><b>${p.pos} ${p.name}</b><span>${p.school} &middot; age ${p.age}</span></div>
        </div>
        <div class="ovr${p.exact ? ' is-exact' : ''}"><u>${p.overallLow === p.overallHigh ? p.overallLow
          : `${p.overallLow}\u2013${p.overallHigh}`}</u><span>${p.confidence}</span></div>
      </header>
      <div class="traits">${traits}</div>
      ${combine}`;
    const acts = el('div', 'prospect-acts');
    const look = el('button', 'btn btn-tiny', `Scout (${p.scouted}/4)`);
    look.disabled = left <= 0 || p.scouted >= 4;
    look.addEventListener('click', () => run(link.scoutLook(p.id), look, 'Scouting…'));
    const bd = el('button', 'btn btn-tiny', on ? 'On your board' : 'Add to board');
    bd.disabled = !on && boarded.length >= BOARD_MAX;
    bd.addEventListener('click', () => run(link.board(p.id), bd, 'Saving…'));
    acts.append(look, bd);
    card.append(acts);
    wrap.append(card);
  }
  pane.append(wrap);

  const fas = (S.freeAgents || []).filter((f) => f.side === side).slice(0, 8);
  const already = S.signed?.[seat];
  pane.append(card('Free agents', already
    ? note(`You signed ${already.pos} ${already.name}.`)
    : table(['', 'Rating', 'Age', ''], fas.map((f) => [
        `${f.pos} ${f.name}`, `${f.rating}`, `${f.age}`,
        `<button class="btn btn-tiny" data-sign="${f.id}">Sign</button>`]))
      + noteEl('Veterans have public tape, so the rating is real. The risk is age.')));
  pane.querySelectorAll('[data-sign]').forEach((b) => b.addEventListener('click', () =>
    run(link.sign(b.dataset.sign), b, 'Signing…')));
}

const DZG = { group: null };

/* ---------- the draft room ---------- */

function paneDraft(pane, S, seat) {
  const room = S.draftRoom;
  const slot = onTheClock(S);
  const ours = isOurPick(S);
  const left = S.advocacy?.[seat] ?? 0;
  const taken = new Set(room.picks.map((p) => p.id));
  const boarded = (S.draftBoard?.[seat] || []);
  const view = S.boardView?.[seat] || [];

  // What just happened.
  if (room.lastPick) {
    const lp = room.lastPick;
    pane.append(card(`Round ${lp.round}, pick ${lp.overall} \u2014 your selection`,
      `<p class="verdict-big${lp.advocated ? '' : ' quiet'}">${lp.pos} ${lp.name}</p>`
      + `<p class="scout-note" style="padding:0 .6rem">${lp.school}${
          lp.advocated ? ` &middot; you spent ${lp.advocated} advocating for him`
          : ' &middot; the general manager went his own way'}</p>`
      + (lp.gmBoard ? table(['His board was'], lp.gmBoard.map((b) => [`${b.pos} ${b.name}`])) : '')));
  }

  if (room.done) {
    const mine = S.draftResult || [];
    pane.append(card('Your draft class', mine.length
      ? table(['', '', 'Grade', ''], mine.map((p) => [`R${p.round} #${p.overall}`,
          `${p.pos} ${p.name}`, `${p.rating}`,
          p.started ? '<b class="invited">starts</b>' : 'depth']))
      : note('Your club made no selections.')));
    const missed = S.missedTargets || [];
    if (missed.length) {
      pane.append(card('Off your board, gone elsewhere', table(['', 'Really was', 'Taken'],
        missed.map((p) => [`${p.pos} ${p.name}`, `${p.trueGrade}`,
          p.takenBy ? `${TEAM_BY_ID[p.takenBy]?.name || p.takenBy} #${p.overall}` : 'undrafted']))
        + noteEl('You did the work. He was not your call.')));
    }
    // Signal that the stage's ready-up controls should follow. Returning here
    // unconditionally left the finished draft with no way out of it.
    return true;
  }

  // On the clock.
  const upcoming = room.order.slice(room.cursor, room.cursor + 6)
    .map((o) => [`R${o.round} #${o.overall}`, o.team === S.userTeam
      ? '<mark>Your club</mark>' : TEAM_BY_ID[o.team].name]);
  pane.append(card(ours ? 'You are on the clock' : `On the clock: ${TEAM_BY_ID[slot.team].name}`,
    table(['Pick', ''], upcoming)));

  if (ours) {
    const spent = Object.values(room.pitch || {}).reduce((a, b) => a + b, 0);
    pane.append(card(`Advocacy \u2014 ${left} of ${ADVOCACY} left`,
      noteEl(`Spend it on this pick and it is gone. ${spent
        ? `You have put ${spent} behind someone.` : 'Nothing on the table yet.'}
        The general manager still decides.`)));

    const mine = boarded.map((id) => view.find((p) => p.id === id)).filter(Boolean);
    const rows = mine.map((p) => {
      const gone = taken.has(p.id);
      const by = gone ? room.picks.find((x) => x.id === p.id) : null;
      const put = room.pitch?.[p.id] || 0;
      return [
        `${gone ? '<s>' : ''}${p.pos} ${p.name}${gone ? '</s>' : ''}`
          + ` <em class="projtag">#${p.projected}</em>`,
        `${p.overallLow}\u2013${p.overallHigh}`,
        gone ? `<span class="gone">${TEAM_BY_ID[by.team].name} #${by.overall}</span>`
          : put ? `<b class="invited">${put} spent</b>` : 'available',
        gone ? '' : `<button class="btn btn-tiny" data-adv="${p.id}" data-amt="1"${left < 1 ? ' disabled' : ''}>+1</button>`
          + ` <button class="btn btn-tiny" data-adv="${p.id}" data-amt="3"${left < 3 ? ' disabled' : ''}>+3</button>`,
      ];
    });
    pane.append(card('Your board', rows.length
      ? table(['', 'Grade', 'Status', ''], rows)
      : note('You never put anyone on your board. Nothing to argue for.')));
    pane.querySelectorAll('[data-adv]').forEach((b) => b.addEventListener('click', () =>
      run(link.advocate(b.dataset.adv, Number(b.dataset.amt)), b, 'Saving…')));
  }

  const acts = el('div', 'season-actions');
  const btn = el('button', 'btn btn-primary', ours ? 'Let him make the pick' : 'Run the next picks');
  btn.addEventListener('click', () => run(link.runPicks(ours), btn, 'Running picks…'));
  acts.append(btn);
  pane.append(acts);
}

/** Everything you have done, which is what a club is actually buying. */
function careerCard(S, seat) {
  const c = careerResume(S, seat);
  const unitLabel = seat === 'OC' ? 'Offense' : 'Defense';
  if (c.seasons <= 1 && !c.years.length) {
    return card('Your career', table(['', ''], [
      ['Seasons as a coordinator', '1'],
      ['This year', `${c.current.record.w}\u2013${c.current.record.l}`],
      [`${unitLabel}, points`, ordinal(c.current.ranks.points)],
    ]) + noteEl('One year is a sample. Clubs want to see you do it again.'));
  }
  const HON = { coy: 'Coach of the Year', ocoy: 'Coordinator of the Year',
    dcoy: 'Coordinator of the Year' };
  const rows = c.years.map((y) => [
    `${y.year}`, `${y.w}\u2013${y.l}`, ordinal(y.ranks.points), y.ypp.toFixed(2),
    [(y.honours || []).map((k) => `<b class="invited">${HON[k] || k}</b>`).join(' '),
     y.champion ? '<b class="invited">champion</b>' : y.madePlayoffs ? 'playoffs' : '',
    ].filter(Boolean).join(' &middot; '),
  ]);
  rows.push([`${S.year}`, `${c.current.record.w}\u2013${c.current.record.l}`,
    ordinal(c.current.ranks.points), c.current.stats.ypp.toFixed(2), '<em>this year</em>']);
  return card(`Your career \u2014 ${c.seasons} season${c.seasons === 1 ? '' : 's'}`,
    table(['Year', 'Record', `${unitLabel} pts`, 'Y/P', ''], rows)
    + noteEl(`${c.totalW}\u2013${c.totalL} overall &middot; best unit finish ${ordinal(c.bestRank)}`
      + ` &middot; ${c.playoffs} playoff berth${c.playoffs === 1 ? '' : 's'}`
      + (c.rings ? ` &middot; ${c.rings} title${c.rings === 1 ? '' : 's'}` : '')
      + ` &middot; you called ${Math.round(c.calledPct * 100)}% of your games`));
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

/* ---------- the depth chart ----------
   Both units, because a coordinator argues for his own side but has to know
   what the club as a whole is short of. */

function paneRoster(pane, S) {
  const mySide = app.seat === 'OC' ? 'offense' : 'defense';
  if (!ROS.side) ROS.side = mySide;

  const tabs = el('div', 'tabs grp-tabs');
  for (const [key, label] of [['offense', 'Offense'], ['defense', 'Defense']]) {
    const b = el('button', 'tab' + (ROS.side === key ? ' is-on' : ''),
      label + (key === mySide ? ' <i>yours</i>' : ''));
    b.addEventListener('click', () => { ROS.side = key; renderSeason(); });
    tabs.append(b);
  }
  pane.append(tabs);

  const side = ROS.side;
  const rows = depthChart(S, side);
  const u = rosterUnit(S, side);

  pane.append(card('Unit at a glance', table(['', ''], [
    ['Average rating', `${u.average}`],
    ['Weakest positions', u.holes.length
      ? u.holes.map((h) => `${h.pos} (${h.rating})`).join(', ') : 'nothing glaring'],
    ['Players 31 or older', `${u.agingCount}`],
    ['Players 23 or younger', `${u.youngCount}`],
  ]) + noteEl(side === mySide
    ? 'This is the unit you are judged on. Holes here are what your scouting should chase.'
    : 'Not your side of the ball, but the club drafts for both.')));

  // Group by position so the depth chart reads as a depth chart.
  const groups = [];
  for (const r of rows) {
    let g = groups.find((x) => x.pos === r.pos);
    if (!g) { g = { pos: r.pos, players: [] }; groups.push(g); }
    g.players.push(r);
  }

  const box = el('section', 'depth');
  for (const g of groups) {
    const grp = el('div', 'depth-group', `<h4>${g.pos}</h4>`);
    g.players.forEach((p, i) => {
      const stat = side === 'offense'
        ? (p.att ? `${p.comp}/${p.att}, ${p.passYards} yds, ${p.passTD} TD, ${p.int} INT`
          : p.carries ? `${p.carries} car, ${p.rushYards} yds, ${p.rushTD} TD`
            + (p.targets ? ` &middot; ${p.rec} rec, ${p.recYards} yds` : '')
          : p.targets ? `${p.rec}/${p.targets}, ${p.recYards} yds, ${p.recTD} TD`
          : 'no counting stats')
        : `${p.tackles} tkl &middot; ${p.sacks} sk &middot; ${p.pbu} PBU &middot; ${p.ints} INT`;
      const row = el('div', 'depth-row' + (i === 0 ? ' is-starter' : ''));
      row.innerHTML = `
        <span class="slot">${i === 0 ? 'ST' : i + 1}</span>
        <span class="num">${p.number ?? ''}</span>
        <span class="who"><b>${p.name}</b>${p.rookie ? ' <em class="rk">R</em>' : ''}
          <span>age ${p.age}</span></span>
        <span class="rate ${p.rating >= 85 ? 'good' : p.rating < 65 ? 'bad' : ''}">${p.rating}</span>
        <span class="line">${stat}</span>`;
      grp.append(row);
    });
    box.append(grp);
  }
  pane.append(box);

  // Always show the five thinnest spots, even on a good unit — a coordinator
  // still wants to know where he is least strong before the draft.
  const ranked = rosterNeeds(S, side).slice(0, 5);
  const below = ranked.filter((r) => r.gap > 0).length;
  pane.append(card(below ? 'Where you are short' : 'Your thinnest spots',
    table(['Position', 'Starters', 'Oldest', 'Depth', 'Against par'], ranked.map((r) =>
      [r.pos, `${r.rating}`, `${r.age}`, `${r.depth}`,
       `<span class="gap ${r.gap > 4 ? 'bad' : r.gap < -4 ? 'good' : ''}">${
         r.gap > 0 ? '\u2212' : '+'}${Math.abs(r.gap).toFixed(1)}</span>`]))
    + noteEl(below
      ? 'Starters averaged and measured against what the position is normally worth. These are what your scouting should chase.'
      : 'Nothing here grades below par, so the draft is about raising the ceiling rather than filling a hole.')));
}

const ROS = { side: null };

/* ---------- awards ---------- */

function paneAwards(pane, S) {
  // Voted when the calendar closes; before that, show where the race stands.
  const done = S.phase === 'offseason' || S.phase === 'hired' || S.phase === 'done';
  const A = S.awards || (S.results.length >= 32 ? seasonAwards(S) : null);
  if (!A) {
    pane.append(card('Season awards',
      note('Nothing to vote on yet. The ballots come in once the season has some games behind it.')));
    return;
  }
  if (!done) {
    pane.append(card('The race so far',
      noteEl(`Week ${S.week}. Nothing is decided until the season ends, but this is who the voters are watching.`)));
  }

  const rows = A.awards.filter((x) => x.winner).map((x) => {
    const w = x.winner;
    const mine = w.teamId === S.userTeam;
    return [
      x.label,
      `${mine ? '<mark>' : ''}${w.pos} ${w.name}${mine ? '</mark>' : ''}`
        + `<em class="awteam">${TEAM_BY_ID[w.teamId].name}</em>`,
      w.headline,
    ];
  });
  pane.append(card(done ? `${A.year} honours` : 'Leading the vote',
    table(['', 'Player', ''], rows)));

  const staff = A.staff.map((x) => {
    const mine = x.teamId === S.userTeam;
    const who = x.mine ? 'You' : (x.name || `${TEAM_BY_ID[x.teamId].city} staff`);
    return [x.label, `${mine ? '<mark>' : ''}${who}${mine ? '</mark>' : ''}`
      + `<em class="awteam">${TEAM_BY_ID[x.teamId].name}</em>`, x.note];
  });
  pane.append(card('Staff', table(['', '', ''], staff)));

  const yours = A.staff.filter((x) => x.mine);
  if (yours.length) {
    pane.append(card('On your résumé',
      `<p class="verdict-big">${yours.map((x) => x.label).join(' &middot; ')}</p>`
      + noteEl('Hiring clubs see this.')));
  }
}

function paneResume(pane, S) {
  const R = resume(S, app.seat);
  const label = app.seat === 'OC' ? 'Offense' : 'Defense';
  pane.append(careerCard(S, app.seat));
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
  // Set before create(), because create() emits a render and the shared-season
  // branch of render() clears liveCfg — which left the finished game with no
  // config to build a box score against.
  app.liveCfg = cfg;
  app.t = new LocalTransport();
  await app.t.create({
    name: app.name, seat: app.seat,
    teamName: cfg.teamName, oppName: cfg.oppName,
    usRecord: cfg.usRecord, themRecord: cfg.themRecord,
    rosters: cfg.rosters, firstPossession: cfg.firstPossession,
    seasonSeed: cfg.seasonSeed, cpuIdentity: cfg.cpuIdentity, us: cfg.us, them: cfg.them,
    autoSeat: app.seat === 'OC' ? 'DC' : 'OC',
  });
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
  const cpuConversionPending = s.pendingConversion?.team === 'CPU';
  const autoSeatPending = g.autoSeat && onClock === g.autoSeat;
  const isMyCall = mine === onClock && g.status === 'live'
    && !cpuConversionPending && !autoSeatPending;

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

  renderTimeouts(g, s, isMyCall);
  $('tempo-row').hidden = !(isMyCall && mine === 'OC') || !!s.pendingConversion;
  document.querySelectorAll('#tempo-row .chip').forEach((c) => {
    c.classList.toggle('is-on', c.dataset.tempo === (g.gameplan?.OC?.tempo || 'normal'));
  });

  if (g.status === 'final') { renderFinal(g, plays || []); return; }
  if (cpuConversionPending) {
    $('call-title').textContent = 'Opponent conversion';
    $('sheet').innerHTML = '<div class="prep-block"><h3>Special teams</h3><p>The opponent is choosing its conversion.</p></div>';
    settleAutomaticCall();
  } else if (autoSeatPending) {
    $('call-title').textContent = 'Staff call';
    $('sheet').innerHTML = '<div class="prep-block"><h3>Other side of the ball</h3><p>Your AI coordinator is making the call.</p></div>';
    settleAutomaticCall();
  } else if (isMyCall) renderCallSheet(g, s, mine);
  else renderPrep(g, s, mine, onClock);

  managePause(g);
  managePlayClock(g);
}

async function settleAutomaticCall() {
  if (app.busy) return;
  app.busy = true;
  try { await app.t.call({ auto: true }); }
  catch (e) { flash(e.message); }
  finally { app.busy = false; }
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

/** Timeouts are the only clock lever a coordinator has; put them on the board. */
function renderTimeouts(g, s, isMyCall) {
  let host = document.getElementById('timeouts');
  if (!host) {
    host = el('div', 'timeouts');
    host.id = 'timeouts';
    document.querySelector('.board-situation')?.insertBefore(host,
      document.getElementById('btn-pause'));
  }
  const left = s.timeouts?.us ?? 0;
  const dots = [0, 1, 2].map((i) => `<i class="${i < left ? 'on' : ''}"></i>`).join('');
  host.innerHTML = `<span class="to-label">Timeouts</span>${dots}`;
  // Worth spending only when the clock is running and you have one.
  const usable = isMyCall && left > 0 && !s.clockStopped && !s.pendingConversion
    && s.status === 'live';
  if (usable) {
    const b = el('button', 'btn btn-tiny to-use', 'Use one');
    b.addEventListener('click', async () => {
      if (app.busy) return;
      app.busy = true;
      try { await app.t.call({ timeout: true }); }
      catch (e) { flash(e.message); }
      finally { app.busy = false; }
    });
    host.append(b);
  }
}

function renderBoard(g, s) {
  $('us-name').textContent = g.teamName.toUpperCase();
  $('them-name').textContent = g.oppName.toUpperCase();
  const recordText = (r) => r ? `${r.w}-${r.l}${r.t ? `-${r.t}` : ''}` : '';
  $('us-record').textContent = recordText(g.usRecord);
  $('them-record').textContent = recordText(g.themRecord);
  $('us-record').hidden = !g.usRecord;
  $('them-record').hidden = !g.themRecord;
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
  const sheet = $('sheet');
  sheet.className = 'sheet';
  sheet.innerHTML = '';

  // A touchdown pauses everything until the conversion is decided.
  if (s.pendingConversion?.team === 'US') {
    $('call-title').textContent = 'Touchdown — your call';
    const lead = s.score.us - s.score.them;
    const box = el('div', 'group', '<h3>After the touchdown</h3>');
    const mk2 = (label, tag, choice) => {
      const b = el('button', 'call', `<b>${label}</b><span>${tag}</span>`);
      b.addEventListener('click', async () => {
        if (app.busy) return;
        app.busy = true;
        sheet.classList.add('is-locked');
        b.classList.add('is-picked');
        try { await app.t.call({ conversion: choice }); }
        catch (e) { flash(e.message); sheet.classList.remove('is-locked'); b.classList.remove('is-picked'); }
        finally { app.busy = false; }
      });
      return b;
    };
    box.append(mk2('Kick the extra point', 'Nearly automatic \u00b7 94%', 'kick'));
    box.append(mk2('Go for two', 'Coin flip \u00b7 about 48%', 'two'));
    sheet.append(box);
    sheet.insertAdjacentHTML('beforeend',
      `<p class="conv-note">You are ${lead > 0 ? `up ${lead}` : lead < 0 ? `down ${-lead}` : 'level'}.
        Two points is worth it when it changes what you need next.</p>`);
    return;
  }

  $('call-title').textContent = mine === 'OC' ? 'Your call — offense' : 'Your call — defense';

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
      const who = castLine(p);
      if (who) row.insertAdjacentHTML('beforeend', `<div class="cast">${who}</div>`);
      // A timeout or a conversion is not a snap, so "on schedule" means
      // nothing there.
      if (!p.special && !p.conversion && !p.timeout && o.yards != null && !o.penalty) {
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
        .map((e) => ' ' + e.text).join('')}` +
      (castLine(p) ? `<i class="feed-cast">${castLine(p)}</i>` : '') + '</span>');
    feed.append(li);
  }
}

/**
 * Who was actually involved. The engine credits every snap already; this just
 * reads it back, so a line in the feed names the men rather than describing an
 * event that happened to nobody.
 */
function castLine(p) {
  const o = p.outcome;
  const c = o?.cast;
  if (!c) return '';
  // A flag wipes the play out, so nobody carried, caught or tackled anything.
  if (o.penalty && o.penalty.replay) return '';
  if (o.deadBall) return '';
  const nm = (x) => (x ? `<b>${x.pos} ${x.name}</b>` : '');
  const bits = [];

  if (c.carrier) {
    bits.push(nm(c.carrier));
    if (c.forced) bits.push(`fumble forced by ${nm(c.forced)}`);
    else if (c.tackler) bits.push(`tackled by ${nm(c.tackler)}`);
  } else if (c.sacker) {
    bits.push(`${nm(c.passer)} sacked by ${nm(c.sacker)}`);
    if (c.forced) bits.push('ball came loose');
  } else if (c.interceptor) {
    bits.push(`${nm(c.passer)} intercepted by ${nm(c.interceptor)}`);
    if (c.target) bits.push(`intended for ${nm(c.target)}`);
  } else if (c.breakup) {
    bits.push(`${nm(c.passer)} incomplete for ${nm(c.target)}`);
    bits.push(`broken up by ${nm(c.breakup)}`);
  } else if (c.target) {
    bits.push(`${nm(c.passer)} to ${nm(c.target)}`);
    if (c.tackler) bits.push(`tackled by ${nm(c.tackler)}`);
  }
  return bits.filter(Boolean).join(' &middot; ');
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
      run(link.finish(g.id));
      return;
    }
    // Fold the result into the season in the same shape a simulated game
    // produces, then let the rest of the week play out.
    const res = statsFromPlays(plays, s, app.liveCfg);
    res.week = app.season.week;
    res.playoff = app.season.phase === 'playoffs';
    app.season = recordGameFilm(app.season, plays, app.liveCfg, g.filmPoints);
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
