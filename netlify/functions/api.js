// Authoritative game server on Netlify Functions.
// Same guarantees as the Cloud Functions version: the client submits a call and
// nothing else. It never learns the CPU's call before committing, and it can
// never write game state directly.
import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { getAuth } from 'firebase-admin/auth';

import { newGameState, emptyTendencies } from '../../public/shared/engine.js';
import { runToNextDecision, seatOnClock, keyRead, PLAY_CLOCK_MS, FILM_COST } from '../../public/shared/gameflow.js';
import { createSeason, hydrate, dehydrate, userGame, liveConfig, statsFromPlays,
  simRemainingWeek, advanceWeek, startOffseason, recordInterview,
  setOffseasonReady, advanceOffseason, canReady, bothReady,
  setWeekReady, canAdvanceWeek, weekReadyBoth,
  openScouting, useScout, toggleBoard, signFreeAgent, boardViews,
  startDraft, advocate, runPicks, isOurPick } from '../../public/shared/season.js';
import { TEAM_BY_ID } from '../../public/shared/league.js';

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
const seasonRef = (id) => store().collection('seasons').doc(id);

const seatsIn = (doc) => ['OC', 'DC'].filter((s) => doc.seats?.[s]);

// True ratings live here and are never readable by a client. The class is
// generated from a secret seed for the same reason: the season seed is public,
// so anything derived from it can be regenerated in a browser console.
const privateRef = (id) => seasonRef(id).collection('private').doc('draft');

async function loadBoard(seasonId) {
  const snap = await privateRef(seasonId).get();
  return snap.exists ? snap.data() : null;
}

/** Split a scouting-stage season into what is stored where. */
async function saveScouting(seasonId, season, seats) {
  const { board, draftSeed, ...pub } = season;
  await privateRef(seasonId).set({ board, draftSeed: draftSeed || null });
  await seasonRef(seasonId).update({ ...dehydrate(pub), ...boardViews(board, seats) });
  return pub;
}

async function loadSeason(id, uid) {
  const snap = await seasonRef(id).get();
  if (!snap.exists) throw new ApiError(404, 'No season with that code.');
  const doc = snap.data();
  const seat = doc.seats?.OC?.uid === uid ? 'OC' : doc.seats?.DC?.uid === uid ? 'DC' : null;
  if (!seat) throw new ApiError(403, 'You are not in this season.');
  return { doc, seat, season: hydrate(doc) };
}
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

  /* ------------------------------------------------------------ seasons */

  async createSeason(uid, { seat = 'OC', displayName = 'Coordinator', teamId }) {
    if (!['OC', 'DC'].includes(seat)) bad('Pick OC or DC.');
    if (!TEAM_BY_ID[teamId]) bad('Unknown club.');
    const seed = Math.random().toString(36).slice(2, 10);
    const base = dehydrate(createSeason({ seed, userTeam: teamId }));
    const ref = seasonRef(store().collection('seasons').doc().id);
    await ref.set({
      ...base,
      id: ref.id,
      createdAt: FieldValue.serverTimestamp(),
      seats: { [seat]: { uid, displayName } },
      uids: [uid],
      vote: { OC: null, DC: null },
      currentGameId: null,
    });
    return { seasonId: ref.id, seat };
  },

  async joinSeason(uid, { seasonId, displayName = 'Coordinator' }) {
    return store().runTransaction(async (tx) => {
      const ref = seasonRef(seasonId);
      const snap = await tx.get(ref);
      if (!snap.exists) throw new ApiError(404, 'No season with that code.');
      const d = snap.data();
      if (d.seats?.OC?.uid === uid) return { seat: 'OC' };
      if (d.seats?.DC?.uid === uid) return { seat: 'DC' };
      const open = !d.seats?.OC ? 'OC' : !d.seats?.DC ? 'DC' : null;
      if (!open) throw new ApiError(409, 'Both coordinator seats are taken.');
      tx.update(ref, {
        [`seats.${open}`]: { uid, displayName },
        uids: FieldValue.arrayUnion(uid),
      });
      return { seat: open };
    });
  },

  /**
   * Each coordinator says whether they want to call this week's game.
   * Simulating needs both to agree; either one can insist on playing it,
   * because calling plays is the whole point and nobody should be able to
   * skip their rival's game for them.
   */
  async voteWeek(uid, { seasonId, choice }) {
    if (!['call', 'sim'].includes(choice)) bad('Choice must be call or sim.');
    const { doc, seat, season } = await loadSeason(seasonId, uid);
    if (doc.currentGameId) throw new ApiError(409, 'This week already has a game running.');

    const vote = { ...doc.vote, [seat]: choice };
    const other = seat === 'OC' ? 'DC' : 'OC';
    const bothIn = !!doc.seats?.[other];
    const patch = { vote };

    if (choice === 'call' || (bothIn && vote[other] === 'call')) {
      const g = userGame(season);
      if (g) {
        const cfg = liveConfig(season, g);
        const ref = gameRef(store().collection('games').doc().id);
        await ref.set({
          id: ref.id,
          status: 'lobby',
          seasonId, seasonWeek: season.week,
          teamName: cfg.teamName, oppName: cfg.oppName,
          rosters: cfg.rosters,
          atHome: cfg.atHome, us: cfg.us, them: cfg.them,
          seats: {
            ...(doc.seats.OC ? { OC: { ...doc.seats.OC, ready: false } } : {}),
            ...(doc.seats.DC ? { DC: { ...doc.seats.DC, ready: false } } : {}),
          },
          uids: doc.uids,
          state: newGameState({ firstPossession: cfg.firstPossession }),
          tendencies: { US: emptyTendencies(), CPU: emptyTendencies() },
          gameplan: { OC: { aggression: 0, tempo: 'normal' }, DC: { aggression: 0, tempo: 'normal' } },
          filmPoints: { OC: 0, DC: 0 },
          pending: { playIndex: 0, deadline: null, prediction: null, hint: null },
          pause: { state: 'none' },
          chirps: [],
          // Only one seat filled means the other unit runs itself.
          autoSeat: doc.seats.OC && doc.seats.DC ? null : (doc.seats.OC ? 'DC' : 'OC'),
        });
        patch.currentGameId = ref.id;
      }
    } else if (vote.OC === 'sim' && (!bothIn || vote.DC === 'sim')) {
      const simmed = simRemainingWeek(season);
      Object.assign(patch, dehydrate(simmed), { vote: { OC: null, DC: null } });
    } else if (!bothIn && choice === 'sim') {
      const simmed = simRemainingWeek(season);
      Object.assign(patch, dehydrate(simmed), { vote: { OC: null, DC: null } });
    }

    await seasonRef(seasonId).update(patch);
    return { ok: true, started: !!patch.currentGameId };
  },

  /** Fold a finished game into the season and clear the week. */
  async finishWeek(uid, { seasonId }) {
    const { doc, season } = await loadSeason(seasonId, uid);
    if (!doc.currentGameId) throw new ApiError(409, 'No game to finish.');
    const gSnap = await gameRef(doc.currentGameId).get();
    const game = gSnap.data();
    if (!game || game.status !== 'final') throw new ApiError(409, 'That game is not over.');

    const playsSnap = await gameRef(doc.currentGameId).collection('plays').orderBy('playIndex').get();
    const plays = playsSnap.docs.map((d) => d.data());

    // The result must carry the SCHEDULE's id, not the Firestore document id.
    // Everything downstream — the week pane, simRemainingWeek, the standings —
    // matches games by schedule id. Using the doc id meant a played game was
    // never recognised as finished, so the week was simulated a second time and
    // the team was credited with two results.
    const sched = userGame(season);
    if (!sched) throw new ApiError(409, 'No scheduled game for this week.');
    const cfg = { gameId: sched.id, us: game.us, them: game.them, atHome: game.atHome };
    const result = statsFromPlays(plays, game.state, cfg);
    result.week = doc.week;
    result.playoff = doc.phase === 'playoffs';
    result.gameDocId = doc.currentGameId;

    const withResult = { ...season, results: [...season.results, result] };
    const closed = simRemainingWeek(withResult);
    await seasonRef(seasonId).update({
      ...dehydrate(closed),
      vote: { OC: null, DC: null },
      currentGameId: null,
    });
    return { ok: true };
  },

  /**
   * Ready up for the next week. The calendar only moves when both
   * coordinators have — one of them should never be able to burn a week the
   * other is still working through.
   */
  async advanceSeason(uid, { seasonId, ready = true }) {
    const { doc, seat, season } = await loadSeason(seasonId, uid);
    if (doc.currentGameId) throw new ApiError(409, 'Finish this week\'s game first.');
    if (ready && !canAdvanceWeek(season)) {
      throw new ApiError(409, 'Your club still has a game to play this week.');
    }

    const seats = seatsIn(doc);
    const marked = setWeekReady(season, seat, ready);
    if (!weekReadyBoth(marked, seats)) {
      await seasonRef(seasonId).update({ weekReady: marked.weekReady });
      return { waiting: true, week: season.week, phase: season.phase };
    }

    // The end of the calendar opens the carousel rather than advancing a week.
    const next = marked.phase === 'done'
      ? { ...startOffseason(marked, seats), weekReady: {} }
      : advanceWeek(marked);
    await seasonRef(seasonId).update({ ...dehydrate(next), vote: { OC: null, DC: null } });
    return { waiting: false, week: next.week, phase: next.phase };
  },

  /* ------------------------------------------------------------ offseason */

  /**
   * The client sends which options it picked, never a score. Questions are
   * regenerated from the season seed and graded here, so a candidate cannot
   * hand themselves a perfect interview.
   */
  async recordInterview(uid, { seasonId, teamId, choices }) {
    const { doc, seat, season } = await loadSeason(seasonId, uid);
    if (season.phase !== 'offseason') throw new ApiError(409, 'The carousel is not open.');
    if (season.carousel?.stage !== 'interviews') throw new ApiError(409, 'Not the interview stage yet.');
    if (!(season.carousel.invited?.[seat] || []).includes(teamId)) {
      throw new ApiError(403, 'That club did not ask to see you.');
    }
    if (season.carousel.banked?.[seat]?.[teamId]) throw new ApiError(409, 'You already sat down with them.');
    if (!Array.isArray(choices)) bad('Send the options you picked.');

    const next = recordInterview(season, seat, teamId, choices);
    await seasonRef(seasonId).update({ carousel: next.carousel });
    return { ok: true, remaining: (next.carousel.invited[seat] || [])
      .filter((t) => !next.carousel.banked?.[seat]?.[t]).length };
  },

  /* ---------------------------------------------- scouting and the draft */

  async useScout(uid, { seasonId, prospectId }) {
    const { doc, seat, season } = await loadSeason(seasonId, uid);
    if (season.carousel?.stage !== 'scouting') throw new ApiError(409, 'Not the scouting stage.');
    const priv = await loadBoard(seasonId);
    if (!priv) throw new ApiError(409, 'The board is not set yet.');
    const next = useScout({ ...season, board: priv.board }, seat, prospectId);
    if (next.scoutLeft[seat] === season.scoutLeft[seat]) {
      throw new ApiError(409, 'No looks left, or that is not your side of the ball.');
    }
    await saveScouting(seasonId, { ...next, draftSeed: priv.draftSeed }, seatsIn(doc));
    return { left: next.scoutLeft[seat] };
  },

  /**
   * Install a play or defensive call a coordinator drew. It has to live on the
   * season document: the server resolves every snap, so a play that only
   * exists in one browser is rejected as an unknown call.
   */
  async installPlay(uid, { seasonId, play }) {
    const { seat, season } = await loadSeason(seasonId, uid);
    if (!play?.id || !play.name) bad('That play is missing an id or a name.');
    const side = seat === 'OC' ? 'offense' : 'defense';
    const isDefense = !!play.cov;
    if (isDefense !== (side === 'defense')) {
      throw new ApiError(403, 'You can only install calls for your own unit.');
    }
    const key = isDefense ? 'customDefenses' : 'customPlays';
    const existing = season[key] || [];
    if (existing.length >= 40) throw new ApiError(409, 'That playbook is full.');
    if (existing.some((p) => p.id === play.id)) return { ok: true };
    // Re-derive nothing: the drawing already produced these numbers, and the
    // shape is validated by the resolver the moment it is called.
    await seasonRef(seasonId).update({ [key]: [...existing, play], installedBy: seat });
    return { ok: true, count: existing.length + 1 };
  },

  async toggleBoard(uid, { seasonId, prospectId }) {
    const { seat, season } = await loadSeason(seasonId, uid);
    if (season.carousel?.stage !== 'scouting') throw new ApiError(409, 'Not the scouting stage.');
    const next = toggleBoard(season, seat, prospectId);
    if (next === season) throw new ApiError(409, 'Not your side of the ball, or your board is full.');
    await seasonRef(seasonId).update({ draftBoard: next.draftBoard });
    return { board: next.draftBoard[seat] };
  },

  /* ---------------------------------------------------- the draft room */

  async advocate(uid, { seasonId, prospectId, amount = 1 }) {
    const { doc, seat, season } = await loadSeason(seasonId, uid);
    if (season.carousel?.stage !== 'draft') throw new ApiError(409, 'The draft is not open.');
    const priv = await loadBoard(seasonId);
    const withBoard = { ...season, board: priv?.board || [] };
    if (!isOurPick(withBoard)) throw new ApiError(409, 'Your club is not on the clock.');
    const next = advocate(withBoard, seat, prospectId, amount);
    if (next === withBoard) throw new ApiError(409, 'Out of advocacy, or not your side of the ball.');
    await seasonRef(seasonId).update({ advocacy: next.advocacy, draftRoom: next.draftRoom });
    return { left: next.advocacy[seat] };
  },

  /** Advance the draft. Anyone in the room can run it on. */
  async runPicks(uid, { seasonId, makeOurs }) {
    const { doc, season } = await loadSeason(seasonId, uid);
    if (season.carousel?.stage !== 'draft') throw new ApiError(409, 'The draft is not open.');
    const priv = await loadBoard(seasonId);
    if (!priv) throw new ApiError(409, 'The board is gone.');
    const next = runPicks({ ...season, board: priv.board }, { makeOurs: !!makeOurs });
    const seats = seatsIn(doc);
    const { board, draftSeed, ...pub } = next;
    // Once the draft is done the truth is safe to publish; that is the payoff.
    await seasonRef(seasonId).update({
      ...dehydrate(pub), ...boardViews(priv.board, seats, !!next.draftRoom?.done),
    });
    return { cursor: next.draftRoom.cursor, done: !!next.draftRoom.done };
  },

  async signFreeAgent(uid, { seasonId, faId }) {
    const { seat, season } = await loadSeason(seasonId, uid);
    if (season.carousel?.stage !== 'scouting') throw new ApiError(409, 'Not the scouting stage.');
    if (season.signed?.[seat]) throw new ApiError(409, 'You already signed someone.');
    const next = signFreeAgent(season, seat, faId);
    if (next === season) throw new ApiError(409, 'That player is not available to you.');
    await seasonRef(seasonId).update({
      rosters: next.rosters, freeAgents: next.freeAgents, signed: next.signed,
    });
    return { ok: true };
  },

  /** Ready up. When both coordinators have, the offseason moves on. */
  async readyOffseason(uid, { seasonId, ready = true }) {
    const { doc, seat, season } = await loadSeason(seasonId, uid);
    if (season.phase !== 'offseason') throw new ApiError(409, 'The carousel is not open.');
    if (ready && !canReady(season, seat)) {
      throw new ApiError(409, 'You still have clubs to sit down with.');
    }
    const seats = seatsIn(doc);
    const stage = season.carousel?.stage;
    let next = setOffseasonReady(season, seat, ready);
    if (!bothReady(next, seats)) {
      await seasonRef(seasonId).update({ carousel: next.carousel });
      return { stage, phase: next.phase };
    }

    if (stage === 'decisions' && !next.carousel.hired) {
      // Opening the board: generate it from a secret the clients never see.
      const secret = Math.random().toString(36).slice(2, 14);
      const opened = openScouting(next, secret);
      opened.carousel = { ...opened.carousel, stage: 'scouting', ready: {} };
      await saveScouting(seasonId, { ...opened, draftSeed: secret }, seats);
      return { stage: 'scouting', phase: opened.phase };
    }
    if (stage === 'scouting') {
      // Scouting closes; the room opens with nobody picked yet.
      const priv = await loadBoard(seasonId);
      const opened = startDraft({ ...next, board: priv?.board || [] });
      opened.carousel = { ...opened.carousel, stage: 'draft', ready: {} };
      const { board, draftSeed, ...pub } = opened;
      await seasonRef(seasonId).update({ ...dehydrate(pub), ...boardViews(priv.board, seats) });
      return { stage: 'draft', phase: opened.phase };
    }

    next = advanceOffseason(next, seats);
    await seasonRef(seasonId).update(dehydrate(next));
    return { stage: next.carousel?.stage || null, phase: next.phase };
  },

  /* ------------------------------------------------------------ games */

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

  async submitCall(uid, { gameId, playIndex, callId, special, auto, conversion, timeout }) {
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

      const sim = runToNextDecision(gameId, g, { callId, special, conversion, timeout });
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
