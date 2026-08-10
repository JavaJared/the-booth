// Authoritative game server on Netlify Functions.
// Same guarantees as the Cloud Functions version: the client submits a call and
// nothing else. It never learns the CPU's call before committing, and it can
// never write game state directly.
import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { getAuth } from 'firebase-admin/auth';

import { newGameState, emptyTendencies } from '../../public/shared/engine.js';
import { runToNextDecision, seatOnClock, keyRead, PLAY_CLOCK_MS, FILM_COST } from '../../public/shared/gameflow.js';

class ApiError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const ENV_KEYS = ['FIREBASE_PROJECT_ID', 'FIREBASE_CLIENT_EMAIL', 'FIREBASE_PRIVATE_KEY'];

/**
 * Initialise lazily and inside the request's try/catch. Doing this at module
 * scope meant a missing or malformed environment variable crashed the whole
 * function before any handler ran, and Netlify returned an opaque 502 with no
 * way to tell what was wrong.
 */
let _app = null;
function admin() {
  if (_app) return _app;
  const missing = ENV_KEYS.filter((k) => !process.env[k]);
  if (missing.length) {
    throw new ApiError(500, `Missing environment variable${missing.length > 1 ? 's' : ''}: `
      + `${missing.join(', ')}. Add them in Netlify → Site configuration → Environment `
      + `variables, then trigger a fresh deploy (they are read at build time).`);
  }
  // Netlify stores the key with literal \n sequences; turn them back into newlines.
  const privateKey = process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n');
  if (!privateKey.includes('BEGIN PRIVATE KEY')) {
    throw new ApiError(500, 'FIREBASE_PRIVATE_KEY does not look like a key. Paste the whole '
      + 'private_key value from the service-account JSON, including the '
      + '-----BEGIN PRIVATE KEY----- and -----END PRIVATE KEY----- lines.');
  }
  try {
    _app = getApps().length ? getApps()[0] : initializeApp({
      credential: cert({
        projectId: process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey,
      }),
    });
  } catch (e) {
    throw new ApiError(500, `Firebase admin failed to initialise: ${e.message}`);
  }
  return _app;
}

const store = () => getFirestore(admin());
const gameRef = (id) => store().collection('games').doc(id);
const bad = (msg) => { throw new ApiError(400, msg); };

function seatOf(game, uid) {
  if (game.seats?.OC?.uid === uid) return 'OC';
  if (game.seats?.DC?.uid === uid) return 'DC';
  return null;
}

async function mySeat(gameId, uid) {
  const snap = await gameRef(gameId).get();
  if (!snap.exists) throw new ApiError(404, 'No game with that code.');
  const g = snap.data();
  const seat = seatOf(g, uid);
  if (!seat) throw new ApiError(403, 'You are not in this game.');
  return { g, seat };
}

// ------------------------------------------------------------------ actions
const actions = {
  /** Confirms the function is deployed, the token verified, and admin
   *  credentials actually reach Firestore. */
  async ping(uid) {
    const probe = await store().collection('_health').doc('ping').get();
    return {
      uid, firestore: true, existed: probe.exists,
      projectId: process.env.FIREBASE_PROJECT_ID,
      at: new Date().toISOString(),
    };
  },

  async createGame(uid, { seat = 'OC', displayName = 'Coordinator',
    teamName = 'Cascade', oppName = 'Ironworks' }) {
    if (!['OC', 'DC'].includes(seat)) bad('Pick OC or DC.');
    const ref = gameRef(store().collection('games').doc().id);
    await ref.set({
      id: ref.id,
      status: 'lobby',
      rosterSeed: Math.random().toString(36).slice(2, 12),
      createdAt: FieldValue.serverTimestamp(),
      teamName, oppName,
      seats: { [seat]: { uid, displayName, ready: false } },
      uids: [uid],   // what firestore.rules checks for read access
      state: newGameState({ firstPossession: Math.random() < 0.5 ? 'US' : 'CPU' }),
      tendencies: { US: emptyTendencies(), CPU: emptyTendencies() },
      gameplan: { OC: { aggression: 0, tempo: 'normal' }, DC: { aggression: 0, tempo: 'normal' } },
      filmPoints: { OC: 0, DC: 0 },
      pending: { playIndex: 0, deadline: null, prediction: null, hint: null },
      pause: { state: 'none' },
      chirps: [],
    });
    return { gameId: ref.id, seat };
  },

  async joinGame(uid, { gameId, displayName = 'Coordinator' }) {
    return store().runTransaction(async (tx) => {
      const ref = gameRef(gameId);
      const snap = await tx.get(ref);
      if (!snap.exists) throw new ApiError(404, 'No game with that code.');
      const g = snap.data();
      const existing = seatOf(g, uid);
      if (existing) return { seat: existing };
      const open = !g.seats.OC ? 'OC' : !g.seats.DC ? 'DC' : null;
      if (!open) throw new ApiError(409, 'Both seats are taken.');
      tx.update(ref, {
        [`seats.${open}`]: { uid, displayName, ready: false },
        uids: FieldValue.arrayUnion(uid),
      });
      return { seat: open };
    });
  },

  async setReady(uid, { gameId, ready = true }) {
    return store().runTransaction(async (tx) => {
      const ref = gameRef(gameId);
      const g = (await tx.get(ref)).data();
      const seat = seatOf(g, uid);
      if (!seat) throw new ApiError(403, 'Not your game.');
      const both = (seat === 'OC' ? ready : g.seats.OC?.ready) && (seat === 'DC' ? ready : g.seats.DC?.ready);
      const patch = { [`seats.${seat}.ready`]: ready };
      if (both && (g.status === 'lobby' || g.status === 'paused')) {
        patch.status = 'live';
        patch.pause = { state: 'none' };
        patch['pending.deadline'] = Date.now() + PLAY_CLOCK_MS;
      }
      tx.update(ref, patch);
      return { started: !!both };
    });
  },

  async submitCall(uid, { gameId, playIndex, callId, special, auto }) {
    const ref = gameRef(gameId);
    const plays = await store().runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) throw new ApiError(404, 'No such game.');
      const g = snap.data();
      const seat = seatOf(g, uid);
      if (!seat) throw new ApiError(403, 'Not your game.');
      if (g.status !== 'live') throw new ApiError(409, 'Game is not live.');
      if (g.state.playIndex !== playIndex) throw new ApiError(409, 'Someone already ran that snap.');

      if (seat !== seatOnClock(g.state)) {
        // The idle coordinator may only force a call once the play clock expires.
        if (!auto || !g.pending?.deadline || Date.now() < g.pending.deadline) {
          throw new ApiError(409, 'Not your call.');
        }
      }

      const sim = runToNextDecision(gameId, g, { callId, special });
      tx.update(ref, {
        state: sim.state,
        tendencies: sim.tendencies,
        filmPoints: sim.filmPoints,
        status: sim.state.status === 'final' ? 'final' : 'live',
        'pending.playIndex': sim.state.playIndex,
        'pending.prediction': null,
        'pending.hint': null,
        'pending.deadline': sim.state.status === 'final' ? null : Date.now() + PLAY_CLOCK_MS,
      });
      return sim.plays;
    });

    const batch = store().batch();
    for (const p of plays) batch.set(ref.collection('plays').doc(String(p.playIndex)), p);
    await batch.commit();
    return { ok: true, plays: plays.length };
  },

  async submitPrediction(uid, { gameId, playIndex, guess }) {
    return store().runTransaction(async (tx) => {
      const ref = gameRef(gameId);
      const g = (await tx.get(ref)).data();
      const seat = seatOf(g, uid);
      if (!seat) throw new ApiError(403, 'Not your game.');
      if (seat === seatOnClock(g.state)) throw new ApiError(409, 'You are calling this play.');
      if (g.state.playIndex !== playIndex) throw new ApiError(409, 'That snap already happened.');
      tx.update(ref, { 'pending.prediction': { seat, guess, playIndex } });
      return { ok: true };
    });
  },

  async setGameplan(uid, { gameId, plan }) {
    const { seat } = await mySeat(gameId, uid);
    const clean = {
      aggression: Math.max(-1, Math.min(1, Number(plan?.aggression) || 0)),
      tempo: ['normal', 'hurry', 'chew'].includes(plan?.tempo) ? plan.tempo : 'normal',
    };
    await gameRef(gameId).update({ [`gameplan.${seat}`]: clean });
    return clean;
  },

  async readKeys(uid, { gameId }) {
    return store().runTransaction(async (tx) => {
      const ref = gameRef(gameId);
      const g = (await tx.get(ref)).data();
      const seat = seatOf(g, uid);
      if (!seat) throw new ApiError(403, 'Not your game.');
      if (seat !== seatOnClock(g.state)) throw new ApiError(409, 'Only the caller can read keys.');
      if ((g.filmPoints?.[seat] || 0) < FILM_COST) throw new ApiError(409, 'Not enough film points.');
      const hint = keyRead(gameId, g);
      tx.update(ref, {
        [`filmPoints.${seat}`]: FieldValue.increment(-FILM_COST),
        'pending.hint': { seat, playIndex: g.state.playIndex, text: hint },
      });
      return { hint };
    });
  },

  async proposePause(uid, { gameId, reason = '' }) {
    const { g, seat } = await mySeat(gameId, uid);
    if (g.status !== 'live') throw new ApiError(409, 'Game is not live.');
    await gameRef(gameId).update({
      pause: { state: 'proposed', by: seat, reason: String(reason).slice(0, 120) },
    });
    return { ok: true };
  },

  async respondPause(uid, { gameId, accept }) {
    return store().runTransaction(async (tx) => {
      const ref = gameRef(gameId);
      const g = (await tx.get(ref)).data();
      const seat = seatOf(g, uid);
      if (!seat) throw new ApiError(403, 'Not your game.');
      if (g.pause?.state !== 'proposed') throw new ApiError(409, 'Nothing to respond to.');
      if (g.pause.by === seat) throw new ApiError(409, 'You proposed it.');
      if (!accept) { tx.update(ref, { pause: { state: 'none', declinedBy: seat } }); return { paused: false }; }
      tx.update(ref, {
        status: 'paused',
        pause: { state: 'active', by: g.pause.by },
        'pending.deadline': null,
        'seats.OC.ready': false,
        'seats.DC.ready': false,
      });
      return { paused: true };
    });
  },

  async chirp(uid, { gameId, text }) {
    const { g, seat } = await mySeat(gameId, uid);
    const chirps = [...(g.chirps || []), { seat, text: String(text).slice(0, 80), at: Date.now() }].slice(-8);
    await gameRef(gameId).update({ chirps });
    return { ok: true };
  },
};

// ------------------------------------------------------------------ handler
export default async (req) => {
  if (req.method === 'OPTIONS') return new Response('', { status: 204 });
  if (req.method !== 'POST') return json({ error: 'POST only.' }, 405);

  try {
    const token = (req.headers.get('authorization') || '').replace(/^Bearer /, '');
    if (!token) throw new ApiError(401, 'Sign in first.');
    const { uid } = await getAuth(admin()).verifyIdToken(token);

    const { action, data = {} } = await req.json();
    const fn = actions[action];
    if (!fn) throw new ApiError(400, `Unknown action ${action}.`);

    return json({ data: await fn(uid, data) });
  } catch (err) {
    const status = err.status || 500;
    if (status >= 500) console.error(err);
    return json({ error: err.message || 'Something went wrong.' }, status);
  }
};

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
