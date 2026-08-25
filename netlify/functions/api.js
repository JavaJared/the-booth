// Authoritative game server on Netlify Functions.
// Same guarantees as the Cloud Functions version: the client submits a call and
// nothing else. It never learns the CPU's call before committing, and it can
// never write game state directly.
import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { getAuth } from 'firebase-admin/auth';
import { randomBytes } from 'node:crypto';

import { newGameState, emptyTendencies } from '../../public/shared/engine.js';
import { runToNextDecision, seatOnClock, keyRead, PLAY_CLOCK_MS, FILM_COST } from '../../public/shared/gameflow.js';
import { createSeason, hydrate, dehydrate, userGame, liveConfig, statsFromPlays,
  simRemainingWeek, advanceWeek, startOffseason, recordInterview,
  setOffseasonReady, advanceOffseason, canReady, bothReady,
  setWeekReady, canAdvanceWeek, weekReadyBoth,
  openScouting, useScout, toggleBoard, signFreeAgent, boardViews,
  startDraft, advocate, runPicks, isOurPick, record as seasonRecord,
  weekLabel, finishedGameRecorded, recordGameFilm, unlockFilmOverlay,
  filmOverlayKey } from '../../public/shared/season.js';
import { TEAM_BY_ID } from '../../public/shared/league.js';
import { OFF_BY_ID, DEF_BY_ID, registerSeasonCalls,
  seasonCallIds } from '../../public/shared/playbook.js';
import { addPracticePeriod } from '../../public/shared/practice.js';
import { applyGamePerformanceDevelopment } from '../../public/shared/progression.js';
import { inviteCode, normalizeInviteCode } from '../../public/shared/codes.js';

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
const MAX_SEASON_SLOTS = 5;
const BUILT_IN_CALL_IDS = new Set([...Object.keys(OFF_BY_ID), ...Object.keys(DEF_BY_ID)]);
const seasonCallCache = new Map();

const alreadyExists = (error) => error?.code === 6 || error?.code === 'already-exists'
  || /already exists/i.test(error?.message || '');

/** Reserve a short document id atomically. `create`/`batch.create` makes a
 * collision retry safe even when two requests choose the same code together. */
async function createInviteDocument(collectionName, write) {
  for (let attempt = 0; attempt < 16; attempt++) {
    const ref = store().collection(collectionName).doc(inviteCode(randomBytes(4)));
    try {
      await write(ref);
      return ref;
    } catch (error) {
      if (!alreadyExists(error)) throw error;
    }
  }
  throw new ApiError(503, 'Could not reserve an invitation code. Try again.');
}

function cacheSeasonCalls(seasonId, season) {
  const calls = {
    customPlays: season.customPlays || [],
    customDefenses: season.customDefenses || [],
  };
  const entry = { calls, ids: seasonCallIds(calls) };
  seasonCallCache.set(seasonId, entry);
  registerSeasonCalls(calls);
  return entry;
}

async function activeSeasonsFor(uid) {
  const snap = await store().collection('seasons').where('uids', 'array-contains', uid).limit(25).get();
  return snap.docs.filter((d) => !(d.data().archivedUids || []).includes(uid));
}

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

  async listMySeasons(uid) {
    const docs = await activeSeasonsFor(uid);
    const seasons = docs.map((snap) => {
      const d = snap.data();
      const seat = d.seats?.OC?.uid === uid ? 'OC' : 'DC';
      const rec = seasonRecord(d, d.userTeam);
      return {
        id: snap.id,
        slotName: d.slotName || `${TEAM_BY_ID[d.userTeam]?.name || 'Team'} career`,
        teamId: d.userTeam,
        teamName: TEAM_BY_ID[d.userTeam]
          ? `${TEAM_BY_ID[d.userTeam].city} ${TEAM_BY_ID[d.userTeam].name}` : 'Unknown club',
        seat,
        year: d.year,
        week: d.week,
        weekLabel: weekLabel(d.week),
        phase: d.phase,
        record: rec,
        currentGameId: d.currentGameId || null,
        legacyImportId: d.legacyImportId || null,
        createdAt: d.createdAt?.toMillis?.() || 0,
      };
    }).sort((a, b) => b.createdAt - a.createdAt);
    return { seasons, maxSlots: MAX_SEASON_SLOTS };
  },

  async archiveSeason(uid, { seasonId }) {
    const { doc } = await loadSeason(seasonId, uid);
    if (doc.currentGameId) throw new ApiError(409, 'Finish the current game before retiring this save.');
    await seasonRef(seasonId).update({ archivedUids: FieldValue.arrayUnion(uid) });
    return { ok: true };
  },

  async importLocalSeason(uid, {
    season: saved, seat = 'OC', displayName = 'Coordinator', slotName = '', migrationId = '',
  }) {
    if (!['OC', 'DC'].includes(seat)) bad('The local save has an invalid coordinator seat.');
    if (!saved || typeof saved !== 'object' || Array.isArray(saved)) bad('No local season was supplied.');
    if (!TEAM_BY_ID[saved.userTeam]) bad('The local save has an unknown club.');
    if (typeof saved.seed !== 'string' || !saved.seed) bad('The local save is missing its season seed.');
    if (!Array.isArray(saved.results)) bad('The local save has invalid results.');
    if (Buffer.byteLength(JSON.stringify(saved), 'utf8') > 850_000) {
      throw new ApiError(413, 'That local save is too large to import safely.');
    }
    const importId = String(migrationId || '').trim().slice(0, 80);
    if (!importId) bad('The migration is missing its device identifier.');

    // Network retries are safe: the device identifier maps one legacy save to
    // one Firestore document instead of consuming another slot.
    const active = await activeSeasonsFor(uid);
    const existing = active.find((snap) => snap.data().legacyImportId === importId);
    if (existing) {
      const d = existing.data();
      return { seasonId: existing.id, seat: d.seats?.OC?.uid === uid ? 'OC' : 'DC', alreadyImported: true };
    }
    if (active.length >= MAX_SEASON_SLOTS) {
      throw new ApiError(409, `All ${MAX_SEASON_SLOTS} season save slots are full.`);
    }

    // Never trust ownership or server metadata from localStorage. The season
    // simulation state is retained, while identity and timestamps are rebuilt.
    const clean = JSON.parse(JSON.stringify(saved));
    for (const key of ['id', 'seats', 'uids', 'vote', 'currentGameId', 'createdAt',
      'archivedUids', 'slotName', 'legacyImportId', 'importedAt', 'boardOC', 'boardDC']) {
      delete clean[key];
    }
    const hydrated = hydrate(clean);
    const { board, draftSeed, ...publicSeason } = hydrated;
    const seatDoc = { uid, displayName: String(displayName || 'Coordinator').slice(0, 60) };
    const ref = await createInviteDocument('seasons', async (candidate) => {
      const batch = store().batch();
      batch.create(candidate, {
        ...dehydrate(publicSeason),
        ...(Array.isArray(board) ? boardViews(board, [seat]) : {}),
        id: candidate.id,
        createdAt: FieldValue.serverTimestamp(),
        importedAt: FieldValue.serverTimestamp(),
        legacyImportId: importId,
        slotName: String(slotName || '').trim().slice(0, 40)
          || `${TEAM_BY_ID[clean.userTeam].name} career (imported)`,
        archivedUids: [],
        seats: { [seat]: seatDoc },
        uids: [uid],
        vote: { OC: null, DC: null },
        currentGameId: null,
      });
      if (Array.isArray(board)) {
        batch.create(privateRef(candidate.id), { board, draftSeed: draftSeed || null });
      }
      await batch.commit();
    });
    return { seasonId: ref.id, seat, alreadyImported: false };
  },

  async createSeason(uid, { seat = 'OC', displayName = 'Coordinator', teamId, slotName = '' }) {
    if (!['OC', 'DC'].includes(seat)) bad('Pick OC or DC.');
    if (!TEAM_BY_ID[teamId]) bad('Unknown club.');
    if ((await activeSeasonsFor(uid)).length >= MAX_SEASON_SLOTS) {
      throw new ApiError(409, `All ${MAX_SEASON_SLOTS} season save slots are full.`);
    }
    const seed = Math.random().toString(36).slice(2, 10);
    const base = dehydrate(createSeason({ seed, userTeam: teamId }));
    const ref = await createInviteDocument('seasons', (candidate) => candidate.create({
      ...base,
      id: candidate.id,
      createdAt: FieldValue.serverTimestamp(),
      slotName: String(slotName || '').trim().slice(0, 40)
        || `${TEAM_BY_ID[teamId].name} career`,
      archivedUids: [],
      seats: { [seat]: { uid, displayName } },
      uids: [uid],
      vote: { OC: null, DC: null },
      currentGameId: null,
    }));
    return { seasonId: ref.id, seat };
  },

  async joinSeason(uid, { seasonId, displayName = 'Coordinator' }) {
    seasonId = normalizeInviteCode(seasonId);
    const current = await seasonRef(seasonId).get();
    if (!current.exists) throw new ApiError(404, 'No season with that code.');
    const currentData = current.data();
    const alreadyIn = currentData.seats?.OC?.uid === uid || currentData.seats?.DC?.uid === uid;
    if (!alreadyIn && (await activeSeasonsFor(uid)).length >= MAX_SEASON_SLOTS) {
      throw new ApiError(409, `All ${MAX_SEASON_SLOTS} season save slots are full.`);
    }
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
          usRecord: cfg.usRecord, themRecord: cfg.themRecord,
          rosters: cfg.rosters,
          practice: cfg.practice,
          atHome: cfg.atHome, us: cfg.us, them: cfg.them,
          seasonSeed: cfg.seasonSeed, cpuIdentity: cfg.cpuIdentity,
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
  async finishWeek(uid, { seasonId, gameId }) {
    const { doc, season } = await loadSeason(seasonId, uid);
    // Both coordinators can leave the final screen at nearly the same time.
    // The first request records the result and clears currentGameId; the
    // matching retry is success, not an error toast on the season screen.
    if (!doc.currentGameId) {
      if (finishedGameRecorded(season, gameId)) return { ok: true, alreadyFinished: true };
      throw new ApiError(409, 'No game to finish.');
    }
    if (gameId && gameId !== doc.currentGameId) {
      if (finishedGameRecorded(season, gameId)) return { ok: true, alreadyFinished: true };
      throw new ApiError(409, 'A different game is currently active.');
    }
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

    const developed = applyGamePerformanceDevelopment(season, result);
    const withResult = recordGameFilm(
      { ...developed.season, results: [...season.results, developed.result] },
      plays, cfg, game.filmPoints);
    const closed = simRemainingWeek(withResult);
    await seasonRef(seasonId).update({
      ...dehydrate(closed),
      vote: { OC: null, DC: null },
      currentGameId: null,
    });
    return { ok: true };
  },

  async unlockFilmOverlay(uid, { seasonId, teamId, callId }) {
    return store().runTransaction(async (tx) => {
      const ref = seasonRef(seasonId);
      const snap = await tx.get(ref);
      if (!snap.exists) throw new ApiError(404, 'No season with that code.');
      const doc = snap.data();
      const seat = doc.seats?.DC?.uid === uid ? 'DC' : doc.seats?.OC?.uid === uid ? 'OC' : null;
      if (!seat) throw new ApiError(403, 'You do not have a seat in this season.');
      const season = hydrate(doc);
      const next = unlockFilmOverlay(season, seat, teamId, callId);
      if (next === season) throw new ApiError(409, 'That overlay is unavailable or you need more film.');
      tx.update(ref, {
        filmBank: next.filmBank,
        filmVersion: next.filmVersion,
        filmOverlays: next.filmOverlays,
      });
      return { balance: next.filmBank[seat], key: filmOverlayKey(callId) };
    });
  },

  /** Assign one of this coordinator's three weekly practice periods. */
  async addPractice(uid, { seasonId, selection }) {
    return store().runTransaction(async (tx) => {
      const ref = seasonRef(seasonId);
      const snap = await tx.get(ref);
      if (!snap.exists) throw new ApiError(404, 'No season with that code.');
      const doc = snap.data();
      const seat = doc.seats?.OC?.uid === uid ? 'OC' : doc.seats?.DC?.uid === uid ? 'DC' : null;
      if (!seat) throw new ApiError(403, 'You do not have a seat in this season.');
      if (doc.currentGameId) throw new ApiError(409, 'Practice is locked once the game begins.');
      const season = hydrate(doc);
      let result;
      try { result = addPracticePeriod(season, seat, selection); }
      catch (e) { throw new ApiError(409, e.message); }
      tx.update(ref, {
        rosters: result.season.rosters,
        practice: result.season.practice,
      });
      return { remaining: result.remaining, improvements: result.improvements };
    });
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
    const ref = await createInviteDocument('games', (candidate) => candidate.create({
      id: candidate.id,
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
    }));
    return { gameId: ref.id, seat };
  },

  async joinGame(uid, { gameId, displayName = 'Coordinator' }) {
    gameId = normalizeInviteCode(gameId);
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
      if (!ready && g.status !== 'lobby') {
        throw new ApiError(409, 'The game has already started.');
      }
      // A solo season deliberately has one empty seat; that unit belongs to
      // the AI and must not keep the human stuck in the lobby.
      const ocReady = g.seats.OC ? (seat === 'OC' ? ready : g.seats.OC.ready) : true;
      const dcReady = g.seats.DC ? (seat === 'DC' ? ready : g.seats.DC.ready) : true;
      const both = ocReady && dcReady;
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

  async submitCall(uid, { gameId, playIndex, callId, special, auto, conversion, timeout }, timings = {}) {
    const ref = gameRef(gameId);
    const firestoreStarted = performance.now();
    const result = await store().runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) throw new ApiError(404, 'No such game.');
      const g = snap.data();
      const seat = seatOf(g, uid);
      if (!seat) throw new ApiError(403, 'Not your game.');
      if (g.status !== 'live') throw new ApiError(409, 'Game is not live.');
      if (g.state.playIndex !== playIndex) throw new ApiError(409, 'Someone already ran that snap.');

      // Built-ins need no extra read. On a cold instance, load a season only
      // when its first custom id arrives; the season-scoped cache then covers
      // every saved call until that serverless instance is recycled.
      let cachedCalls = seasonCallCache.get(g.seasonId);
      const needsCustomCalls = g.seasonId && callId && !BUILT_IN_CALL_IDS.has(callId)
        && !cachedCalls?.ids.has(callId);
      if (needsCustomCalls) {
        const seasonSnap = await tx.get(seasonRef(g.seasonId));
        if (!seasonSnap.exists) throw new ApiError(404, 'This game has no season.');
        cachedCalls = cacheSeasonCalls(g.seasonId, seasonSnap.data());
        if (!cachedCalls.ids.has(callId)) {
          throw new ApiError(400, `Unknown custom call ${callId}.`);
        }
      } else if (cachedCalls && callId && !BUILT_IN_CALL_IDS.has(callId)) {
        // The resolver registry is process-global. Restore this season's exact
        // definitions in case another season used the same custom id.
        registerSeasonCalls(cachedCalls.calls);
      }

      if (seat !== seatOnClock(g.state)) {
        const settlingCpuConversion = auto && g.state.pendingConversion?.team === 'CPU';
        const runningAutoSeat = auto && g.autoSeat === seatOnClock(g.state);
        // The idle coordinator may only force a call once the play clock expires.
        if (!settlingCpuConversion && !runningAutoSeat
          && (!auto || !g.pending?.deadline || Date.now() < g.pending.deadline)) {
          throw new ApiError(409, 'Not your call.');
        }
      }

      const simulationStarted = performance.now();
      // Preserve `auto` all the way into the engine. Dropping it here made a
      // solo season's staff turn look like a human submission, so the resolver
      // tried to execute an undefined call id and left the game stuck.
      const sim = runToNextDecision(gameId, g, { callId, special, auto, conversion, timeout });
      timings.simulation = (timings.simulation || 0) + performance.now() - simulationStarted;
      const status = sim.state.status === 'final' ? 'final' : 'live';
      const deadline = status === 'final' ? null : Date.now() + PLAY_CLOCK_MS;
      tx.update(ref, {
        state: sim.state,
        tendencies: sim.tendencies,
        filmPoints: sim.filmPoints,
        status,
        'pending.playIndex': sim.state.playIndex,
        'pending.prediction': null,
        'pending.hint': null,
        'pending.deadline': deadline,
      });
      // Keep the authoritative state and the play log atomic. This used to be
      // a second batch commit after the transaction, adding another database
      // round trip to every snap and briefly exposing state without its plays.
      for (const p of sim.plays) {
        tx.set(ref.collection('plays').doc(String(p.playIndex)), p);
      }
      return {
        game: {
          ...g,
          state: sim.state,
          tendencies: sim.tendencies,
          filmPoints: sim.filmPoints,
          status,
          pending: {
            ...(g.pending || {}),
            playIndex: sim.state.playIndex,
            prediction: null,
            hint: null,
            deadline,
          },
        },
        plays: sim.plays,
      };
    });
    timings.firestore = performance.now() - firestoreStarted;
    return { ok: true, game: result.game, plays: result.plays };
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

  const started = performance.now();
  const timings = {};
  try {
    const token = (req.headers.get('authorization') || '').replace(/^Bearer /, '');
    if (!token) throw new ApiError(401, 'Sign in first.');
    const authStarted = performance.now();
    const { uid } = await getAuth(admin()).verifyIdToken(token);
    timings.auth = performance.now() - authStarted;

    const { action, data = {} } = await req.json();
    const fn = actions[action];
    if (!fn) throw new ApiError(400, `Unknown action ${action}.`);

    const actionStarted = performance.now();
    const result = await fn(uid, data, timings);
    timings.action = performance.now() - actionStarted;
    timings.total = performance.now() - started;
    return json({ data: result }, 200, { 'server-timing': serverTiming(timings) });
  } catch (err) {
    const status = err.status || 500;
    if (status >= 500) console.error(err);
    timings.total = performance.now() - started;
    return json({ error: err.message || 'Something went wrong.' }, status,
      { 'server-timing': serverTiming(timings) });
  }
};

const serverTiming = (timings) => Object.entries(timings)
  .filter(([, duration]) => Number.isFinite(duration))
  .map(([name, duration]) => `${name};dur=${duration.toFixed(1)}`)
  .join(', ');

const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
