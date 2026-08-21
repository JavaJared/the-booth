// season.js — the campaign. Owns the calendar and the results table; the
// snap-by-snap game and the fast simulation both feed into it in the same
// shape, so a game you called and a game your staff handled are worth the
// same on a résumé.
import { makeSchedule, TEAMS, TEAM_BY_ID, fullName, sortedStandings,
  playoffBracket, wildCardRound, reseed } from './league.js';
import { makeLeagueRosters, teamStrength, migrateRoster, needsMigration } from './roster.js';
import { simGame, seasonUnitStats, unitRanks } from './fastsim.js';
import { mulberry32, hashSeed } from './engine.js';
import { isSuccess } from './scout.js';
import { OFF_BY_ID, DEF_BY_ID, registerSeasonCalls } from './playbook.js';
import { playerLinesFromPlays, playerSeasonTotals, simPlayerLines } from './depth.js';
import { seasonAwards, staffHonours } from './awards.js';
import { makeClass, makeFreeAgents, draftOrder, cpuPick, makePick, addToRoster, ageRoster,
  scout, scoutReport, ROUNDS, SCOUT_POINTS, ADVOCACY, BOARD_MAX } from './draft.js';
import { makeCoaches, firings, openingFor, resumeScore, careerScore, invitesFor,
  interviewQuestions, interviewScore, rivalPool, hire } from './carousel.js';
import {
  FILM_GAME_GRANT, FILM_OVERLAY_COST, FILM_SIM_GRANT,
  filmFromPlays, hasCall, mergeFilmBooks, simulatedGameFilm, teamOffensiveIdentity,
} from './film.js';
import { practicedRoster, practicedStrength, practiceEffects } from './practice.js';

export const REGULAR_WEEKS = 18;
const ROUND_NAMES = { 19: 'Wild Card', 20: 'Divisional', 21: 'Conference Championship', 22: 'The Final' };
export const weekLabel = (w) => (w <= REGULAR_WEEKS ? `Week ${w}` : ROUND_NAMES[w] || 'Offseason');

export function createSeason({ seed, userTeam, year = 2026 }) {
  return hydrate({ seed, year, userTeam, week: 1, phase: 'regular',
    results: [], playoffs: null, customPlays: [], customDefenses: [] });
}

/**
 * Rebuild the derived half of a season from its seed. Rosters and the schedule
 * are deterministic, so only the seed and the accumulating results need to be
 * stored — which keeps a shared season well inside Firestore's document limit.
 * (Once free agency exists, rosters stop being derivable and must be stored.)
 */
export function hydrate(saved) {
  saved = { ...saved, results: dedupeResults(saved.results || []) };
  if (!saved.filmBook) {
    saved.filmBook = saved.results.filter((r) => r.simulated).reduce((book, r) =>
      mergeFilmBooks(book, simulatedGameFilm(saved.seed, r.id, r.home, r.away,
      r.homeStats?.plays, r.awayStats?.plays)), {});
  }
  if (!saved.lastGameFilm) {
    const latest = [...saved.results].filter((r) =>
      r.home === saved.userTeam || r.away === saved.userTeam)
      .sort((a, b) => (b.week || 0) - (a.week || 0))[0];
    if (latest?.simulated) {
      saved.lastGameFilm = {
        week: latest.week,
        opponent: latest.home === saved.userTeam ? latest.away : latest.home,
        detailed: false,
        book: simulatedGameFilm(saved.seed, latest.id, latest.home, latest.away,
          latest.homeStats?.plays, latest.awayStats?.plays),
      };
    }
  }
  const priorGames = saved.results.filter((r) =>
    r.home === saved.userTeam || r.away === saved.userTeam);
  const priorFilm = priorGames.reduce((points, r) =>
    points + (r.played ? FILM_GAME_GRANT : FILM_SIM_GRANT), 0);
  if (!saved.filmBank) {
    saved.filmBank = {
      OC: priorFilm,
      DC: priorFilm,
    };
  } else if ((saved.filmVersion || 1) < 2) {
    // OC overlays did not exist in v1, so credit existing careers for the film
    // their offense would already have earned. The version flag prevents a
    // Firestore hydration from applying the migration more than once.
    saved.filmBank = { ...saved.filmBank, OC: (saved.filmBank.OC || 0) + priorFilm };
  }
  saved.filmVersion = 2;
  saved.filmBank = { OC: 0, DC: 0, ...saved.filmBank };
  saved.filmOverlays = { OC: [], DC: [], ...(saved.filmOverlays || {}) };
  registerSeasonCalls(saved);
  const ids = TEAMS.map((t) => t.id);
  // Generated from the seed on year one, then carried forward: once players can
  // be drafted, signed or aged, a roster stops being a function of the seed.
  let rosters = saved.rosters || makeLeagueRosters(saved.seed, ids);
  // A season saved before the roster expanded still loads; fill it out rather
  // than leaving an old campaign stuck with nineteen men and no ages.
  if (ids.some((id) => needsMigration(rosters[id]))) {
    const usedNames = new Set();
    rosters = Object.fromEntries(ids.map((id) =>
      [id, migrateRoster(rosters[id] || { offense: [], defense: [] }, saved.seed, id, usedNames)]));
  }
  // Full modern saves already carry a schedule, but they may still predate a
  // newer player schema. Always run the roster migration before returning.
  if (saved.rosters && saved.schedule) {
    return {
      ...saved,
      rosters,
      strength: Object.fromEntries(ids.map((id) => [id, teamStrength(rosters[id])])),
    };
  }
  return {
    ...saved,
    schedule: makeSchedule(saved.seed),
    rosters,
    strength: Object.fromEntries(ids.map((id) => [id, teamStrength(rosters[id])])),
  };
}

/** The half worth persisting. Everything else is regenerated by hydrate(). */
export function dehydrate(season) {
  const { schedule, strength, ...core } = season;
  return core;   // rosters travel with the season now
}

/**
 * One result per scheduled game, first write wins. A duplicate would be counted
 * twice by the standings while only one of them showed in the week pane, which
 * is exactly the kind of drift nobody notices until the record is wrong.
 */
export function dedupeResults(results) {
  // Keyed on the matchup rather than the id, so a season already carrying a
  // duplicate from the old doc-id bug heals itself the next time it loads.
  // A game you called outranks one your staff simulated.
  const byKey = new Map();
  for (const r of results) {
    const key = `${r.playoff ? 'po' : ''}${r.week}:${r.home}:${r.away}`;
    const held = byKey.get(key);
    if (!held || (r.played && !held.played)) byKey.set(key, r);
  }
  return [...byKey.values()];
}

export const resultFor = (season, gameId) => season.results.find((r) => r.id === gameId);
export const finishedGameRecorded = (season, gameDocId) => !!gameDocId
  && season.results.some((r) => r.final && r.gameDocId === gameDocId);
export const weekGames = (season, week) => season.schedule.games.filter((g) => g.week === week);

/** The user's game this week, or null on a bye. */
export function userGame(season, week = season.week) {
  if (season.phase === 'playoffs') {
    return (season.playoffs?.games || []).find(
      (g) => g.week === week && (g.home === season.userTeam || g.away === season.userTeam)) || null;
  }
  return weekGames(season, week).find(
    (g) => g.home === season.userTeam || g.away === season.userTeam) || null;
}

/** Current matchup, or the next scheduled one when this week is a bye. */
export function nextUserGame(season) {
  const current = userGame(season);
  if (current || season.phase === 'playoffs') return current;
  const completed = new Set(season.results.map((r) => r.id));
  return season.schedule.games.filter((g) => g.week >= season.week
    && (g.home === season.userTeam || g.away === season.userTeam)
    && !completed.has(g.id)).sort((a, b) => a.week - b.week)[0] || null;
}

export function record(season, teamId = season.userTeam) {
  const row = sortedStandings(season.results.filter((r) => !r.playoff)).byId[teamId];
  return row || { w: 0, l: 0, t: 0 };
}

/* ------------------------------------------------------------ live games */

/** Everything the snap engine needs to run the user's game this week. */
export function liveConfig(season, game) {
  const us = season.userTeam;
  const them = game.home === us ? game.away : game.home;
  const prepared = practicedRoster(season);
  return {
    gameId: game.id,
    us, them,
    atHome: game.home === us,
    teamName: TEAM_BY_ID[us].name,
    oppName: TEAM_BY_ID[them].name,
    usRecord: record(season, us),
    themRecord: record(season, them),
    rosters: { US: prepared, CPU: season.rosters[them] },
    practice: { OC: practiceEffects(season, 'OC'), DC: practiceEffects(season, 'DC') },
    firstPossession: mulberry32(hashSeed(`${season.seed}:${game.id}:toss`))() < 0.5 ? 'US' : 'CPU',
    seasonSeed: season.seed,
    cpuIdentity: teamOffensiveIdentity(season.seed, them),
  };
}

/** Preserve the useful part of a called game's snap log and award weekly film. */
export function recordGameFilm(season, plays, cfg, earned = {}) {
  const gameBook = filmFromPlays(plays, cfg);
  const opponent = cfg.them;
  return {
    ...season,
    filmBook: mergeFilmBooks(season.filmBook, gameBook),
    lastGameFilm: {
      week: season.week,
      opponent,
      detailed: true,
      book: gameBook,
    },
    filmBank: {
      OC: (season.filmBank?.OC || 0) + FILM_GAME_GRANT + Math.max(0, earned?.OC || 0),
      DC: (season.filmBank?.DC || 0) + FILM_GAME_GRANT + Math.max(0, earned?.DC || 0),
    },
  };
}

/** A scouted call is always eligible. The upcoming opponent's complete built-in
    menu is also available from the designer, even before that call appears in
    the tendency sample. */
export function filmOverlayAvailable(season, seat, teamId, callId) {
  const unit = seat === 'DC' ? 'offense' : seat === 'OC' ? 'defense' : null;
  const play = unit === 'offense' ? OFF_BY_ID[callId] : unit === 'defense' ? DEF_BY_ID[callId] : null;
  if (!play || play.custom) return false;
  const game = nextUserGame(season);
  const upcoming = game && (game.home === season.userTeam ? game.away : game.home);
  return hasCall(season.filmBook, teamId, unit, callId) || upcoming === teamId;
}

/** Buy permanent access to one opponent concept in the defensive designer. */
export function unlockFilmOverlay(season, seat, teamId, callId) {
  if (!filmOverlayAvailable(season, seat, teamId, callId)) return season;
  const key = `${teamId}:${callId}`;
  const unlocked = season.filmOverlays?.[seat] || [];
  if (unlocked.includes(key)) return season;
  const balance = season.filmBank?.[seat] || 0;
  if (balance < FILM_OVERLAY_COST) return season;
  return {
    ...season,
    filmBank: { ...season.filmBank, [seat]: balance - FILM_OVERLAY_COST },
    filmOverlays: { ...season.filmOverlays, [seat]: [...unlocked, key] },
  };
}

/**
 * Convert a finished live game into the same stat shape fastsim produces.
 * Without this the résumé would compare unlike numbers.
 */
export function statsFromPlays(plays, state, cfg) {
  const side = (poss) => {
    const snaps = plays.filter((p) => p.possession === poss && p.offId && p.outcome
      && !(p.outcome.penalty && p.outcome.penalty.replay));
    const yards = snaps.reduce((a, p) => a + (p.outcome.yards || 0), 0);
    const thirds = snaps.filter((p) => p.down === 3);
    const rush = snaps.filter((p) => p.outcome.cast?.carrier);
    return {
      plays: snaps.length,
      yards,
      ypp: snaps.length ? +(yards / snaps.length).toFixed(2) : 0,
      rushYards: rush.reduce((a, p) => a + (p.outcome.yards || 0), 0),
      passYards: yards - rush.reduce((a, p) => a + (p.outcome.yards || 0), 0),
      third: thirds.length
        ? +(thirds.filter((p) => (p.outcome.yards || 0) >= p.distance).length / thirds.length).toFixed(3) : 0,
      success: snaps.length
        ? +(snaps.filter((p) => isSuccess(p.down, p.distance, p.outcome.yards || 0)).length / snaps.length).toFixed(3) : 0,
      explosive: snaps.length
        ? +(snaps.filter((p) => (p.outcome.yards || 0) >= 20).length / snaps.length).toFixed(3) : 0,
      turnovers: snaps.filter((p) => p.outcome.turnover).length,
    };
  };

  const ours = side('US'), theirs = side('CPU');
  ours.points = state.score.us; ours.pointsAllowed = state.score.them;
  theirs.points = state.score.them; theirs.pointsAllowed = state.score.us;

  const usIsHome = cfg.atHome;
  return {
    // Per-player lines from the snaps that actually happened. Storing them on
    // the result is what makes the roster page a record rather than a guess.
    players: playerLinesFromPlays(plays),
    id: cfg.gameId,
    home: usIsHome ? cfg.us : cfg.them,
    away: usIsHome ? cfg.them : cfg.us,
    homeScore: usIsHome ? state.score.us : state.score.them,
    awayScore: usIsHome ? state.score.them : state.score.us,
    final: true,
    played: true,
    homeStats: usIsHome ? ours : theirs,
    awayStats: usIsHome ? theirs : ours,
  };
}

/* ------------------------------------------------------------ advancing */

/** Simulate every game this week that has no result yet. */
export function simRemainingWeek(season, week = season.week) {
  const done = new Set(season.results.map((r) => r.id));
  const pending = (season.phase === 'playoffs'
    ? (season.playoffs?.games || []).filter((g) => g.week === week)
    : weekGames(season, week)).filter((g) => !done.has(g.id));
  const us = season.userTeam;
  const prepared = practicedRoster(season);
  const strength = { ...season.strength, [us]: practicedStrength(season) };
  let filmBook = season.filmBook || {};
  let lastGameFilm = season.lastGameFilm || null;
  let filmBank = { OC: 0, DC: 0, ...(season.filmBank || {}) };
  const fresh = pending.map((g) => {
    const r = {
      ...simGame(g.id, g.home, g.away, strength, season.seed),
      week,
      playoff: season.phase === 'playoffs',
    };
    const gameBook = simulatedGameFilm(season.seed, g.id, g.home, g.away,
      r.homeStats?.plays, r.awayStats?.plays);
    filmBook = mergeFilmBooks(filmBook, gameBook);
    // Attribute the week's box score once, here, rather than re-deriving the
    // whole season every time the roster page renders.
    if (g.home === us || g.away === us) {
      const ours = g.home === us ? r.homeStats : r.awayStats;
      const theirs = g.home === us ? r.awayStats : r.homeStats;
      r.players = simPlayerLines(prepared, ours, theirs,
        `${season.seed}:${g.id}`);
      lastGameFilm = {
        week,
        opponent: g.home === us ? g.away : g.home,
        detailed: false,
        book: gameBook,
      };
      filmBank = {
        OC: filmBank.OC + FILM_SIM_GRANT,
        DC: filmBank.DC + FILM_SIM_GRANT,
      };
    }
    return r;
  });
  return {
    ...season,
    results: dedupeResults([...season.results, ...fresh]),
    filmBook,
    lastGameFilm,
    filmBank,
  };
}

/** Close the week out and move the calendar forward. */
export function advanceWeek(season) {
  let s = simRemainingWeek(season);
  if (s.phase === 'regular' && s.week >= REGULAR_WEEKS) return clearWeekReady(startPlayoffs(s));
  if (s.phase === 'playoffs') return clearWeekReady(advancePlayoffs(s));
  return clearWeekReady({ ...s, week: s.week + 1 });
}

/* ------------------------------------------------------------ playoffs */

function startPlayoffs(season) {
  const seeds = playoffBracket(season.results.filter((r) => !r.playoff));
  const games = [];
  for (const conf of ['N', 'S']) {
    for (const m of wildCardRound(seeds[conf])) {
      games.push({ id: `po19-${conf}-${m.home.id}-${m.away.id}`, week: 19, conf,
        home: m.home.id, away: m.away.id });
    }
  }
  return {
    ...season,
    phase: 'playoffs',
    week: 19,
    playoffs: { seeds, games, alive: { N: seeds.N.map((s) => s.id), S: seeds.S.map((s) => s.id) } },
  };
}

function advancePlayoffs(season) {
  const p = season.playoffs;
  const thisRound = p.games.filter((g) => g.week === season.week);
  const survivors = { N: [], S: [] };

  for (const conf of ['N', 'S']) {
    const before = p.alive[conf];
    const out = new Set();
    for (const g of thisRound.filter((x) => x.conf === conf)) {
      const r = season.results.find((x) => x.id === g.id);
      if (!r) continue;
      out.add(r.homeScore >= r.awayScore ? g.away : g.home);
    }
    survivors[conf] = before.filter((id) => !out.has(id));
  }

  const next = season.week + 1;
  if (next === 22) {
    // Both conference champions are decided; one game left.
    const a = survivors.N[0], b = survivors.S[0];
    if (!a || !b) return { ...season, phase: 'done' };
    return { ...season, week: 22, playoffs: { ...p, alive: survivors,
      games: [...p.games, { id: `po22-${a}-${b}`, week: 22, conf: 'F', home: a, away: b }] } };
  }
  if (next > 22) {
    const fin = season.results.find((r) => r.id.startsWith('po22'));
    return { ...season, phase: 'done',
      champion: fin ? (fin.homeScore >= fin.awayScore ? fin.home : fin.away) : null };
  }

  const seedOf = (conf, id) => p.seeds[conf].find((s) => s.id === id);
  const games = [...p.games];
  for (const conf of ['N', 'S']) {
    const { games: pairs } = reseed(survivors[conf].map((id) => seedOf(conf, id)));
    for (const m of pairs) {
      games.push({ id: `po${next}-${conf}-${m.home.id}-${m.away.id}`, week: next, conf,
        home: m.home.id, away: m.away.id });
    }
  }
  return { ...season, week: next, playoffs: { ...p, alive: survivors, games } };
}

/* ------------------------------------------------------------ offseason */

/** Black Monday: work out who was fired and who wants to talk to you. */
export function startOffseason(season, seats = ['OC', 'DC']) {
  const coaches = makeCoaches(season.seed);
  // Vote on the year before anyone gets fired, so the awards reflect the
  // season that was just played rather than the carousel that follows it.
  const honours = season.awards || seasonAwards({ ...season, carousel: { coaches } });
  const openings = firings(season, coaches).map((t) => openingFor(t, season, coaches));
  const resumes = Object.fromEntries(seats.map((s) => [s, resume(season, s)]));

  const careers = Object.fromEntries(seats.map((s) => [s, careerResume(season, s)]));
  const invited = {};
  for (const seat of seats) {
    invited[seat] = openings.filter((o) => {
      const score = careerScore(careers[seat], o);
      const rng = mulberry32(hashSeed(`${season.seed}:invite:${o.teamId}:${seat}`));
      return score >= 46 + rng() * 22;
    }).map((o) => o.teamId);
  }
  return {
    ...season,
    phase: 'offseason',
    awards: honours,
    carousel: {
      coaches, openings, invited,
      resumeScores: Object.fromEntries(seats.map((s) =>
        [s, Object.fromEntries(openings.map((o) => [o.teamId, careerScore(careers[s], o)]))])),
      careerSnapshot: Object.fromEntries(seats.map((s) => [s, {
        seasons: careers[s].seasons, totalW: careers[s].totalW, totalL: careers[s].totalL,
        bestRank: careers[s].bestRank, playoffs: careers[s].playoffs, rings: careers[s].rings,
        years: careers[s].years,
      }])),
      banked: {},      // seat -> { teamId: { interview, resume, total } }
      decisions: null, // filled in when the offseason resolves
      hired: null,     // { seat, teamId } once someone gets the job
      // The offseason moves in the same rhythm as the season: nobody skips
      // ahead while their rival is still reading.
      stage: 'openings',
      ready: {},
    },
  };
}

export const OFFSEASON_STAGES = ['openings', 'interviews', 'decisions', 'scouting', 'draft'];

/* ------------------------------------------ readying up during the season
   The offseason already moves only when both coordinators agree. The weekly
   calendar should work the same way: neither of you gets to burn a week the
   other has not finished with. */

export function setWeekReady(season, seat, ready = true) {
  return { ...season, weekReady: { ...(season.weekReady || {}), [seat]: !!ready } };
}

/** Nobody advances until this week's game is settled. */
export function canAdvanceWeek(season) {
  const g = userGame(season);
  if (!g) return true;                       // bye week, nothing to settle
  return !!season.results.find((r) => r.id === g.id);
}

export const weekReadyBoth = (season, seats) =>
  seats.every((s) => season.weekReady?.[s]);

/** Clear the flags whenever the calendar actually moves. */
const clearWeekReady = (season) => ({ ...season, weekReady: {} });
export { ADVOCACY, BOARD_MAX, SCOUT_POINTS, ROUNDS };

/**
 * Bank an interview without revealing anything. Clubs decide once both
 * coordinators have finished their rounds, so neither of you learns your
 * outcome before the other has sat down.
 */
/**
 * Takes the option indices the candidate picked, not a score. The questions are
 * regenerated from the seed and graded here, so a client cannot award itself a
 * perfect interview.
 */
export function recordInterview(season, seat, teamId, choices) {
  const c = season.carousel;
  const opening = c.openings.find((o) => o.teamId === teamId);
  if (!opening) return season;
  const qs = interviewQuestions(season.seed, teamId, seat);
  const answers = qs.map((q, i) => ({
    question: q,
    choice: Math.max(0, Math.min(q.options.length - 1, Number(choices[i]) || 0)),
  }));
  const iv = interviewScore(answers, opening);
  const rs = careerScore(careerResume(season, seat), opening);
  const banked = {
    ...c.banked,
    [seat]: { ...(c.banked[seat] || {}), [teamId]: {
      interview: iv, resume: rs, total: +(0.55 * rs + 0.45 * iv).toFixed(1),
    } },
  };
  return { ...season, carousel: { ...c, banked } };
}

export function interviewsLeft(season, seat) {
  const c = season.carousel;
  const done = new Set(Object.keys(c.banked?.[seat] || {}));
  return (c.invited[seat] || []).filter((t) => !done.has(t));
}

export const seatReady = (season, seat) => interviewsLeft(season, seat).length === 0;

/**
 * Every club decides at once. Better jobs are filled first, and a coordinator
 * who takes one is off the board for the rest — so the two of you can be in
 * the same room for the same job, and only one walks out with it.
 */
export function resolveHiring(season, seats = ['OC', 'DC']) {
  const c = season.carousel;
  const order = [...c.openings].sort((a, b) => {
    const q = (o) => (season.strength[o.teamId].off - 75) + (season.strength[o.teamId].def - 74);
    return q(b) - q(a);
  });

  const taken = new Set();
  const decisions = [];
  let hired = null;

  for (const o of order) {
    const field = rivalPool(season.seed, o).map((r) => ({ ...r }));
    for (const seat of seats) {
      if (taken.has(seat)) continue;
      const b = c.banked?.[seat]?.[o.teamId];
      if (b) field.push({ name: seat === 'OC' ? 'You (offense)' : 'You (defense)', seat, ...b });
    }
    field.sort((a, b) => b.total - a.total);
    const winner = field[0];
    if (winner?.seat) {
      taken.add(winner.seat);
      if (!hired) hired = { seat: winner.seat, teamId: o.teamId };
    }
    decisions.push({ teamId: o.teamId, field, hiredName: winner?.name, hiredSeat: winner?.seat || null });
  }

  return {
    ...season,
    carousel: { ...c, decisions, hired, resolved: true },
  };
}

/* ---- pacing: both coordinators move through the offseason together ---- */

export function setOffseasonReady(season, seat, ready = true) {
  const c = season.carousel;
  return { ...season, carousel: { ...c, ready: { ...c.ready, [seat]: !!ready } } };
}

/** A seat can only call itself ready once it has nothing left to do. */
export function canReady(season, seat) {
  if (season.carousel.stage !== 'interviews') return true;
  return interviewsLeft(season, seat).length === 0;
}

export const bothReady = (season, seats) => seats.every((s) => season.carousel.ready?.[s]);

/**
 * Move the offseason on when everyone has readied. Leaving the interview stage
 * is where every club decides at once.
 */
export function advanceOffseason(season, seats = ['OC', 'DC']) {
  if (!bothReady(season, seats)) return season;
  const stage = season.carousel.stage;
  const clear = (s, next) => ({ ...s, carousel: { ...s.carousel, stage: next, ready: {} } });

  if (stage === 'openings') return clear(season, 'interviews');
  if (stage === 'interviews') return clear(resolveHiring(season, seats), 'decisions');
  if (stage === 'decisions') {
    // Somebody got out; the game is over and nobody drafts.
    if (season.carousel.hired) return { ...season, phase: 'hired' };
    return clear(openScouting(season), 'scouting');
  }
  // Scouting closes into the draft room, which then runs pick by pick.
  if (stage === 'scouting') return clear(startDraft(season), 'draft');
  return nextSeason(season, seats);
}

/* ------------------------------------------------- scouting and the draft */

/**
 * What each coordinator is allowed to know. True ratings never leave the
 * server: the class is generated from a secret seed, and clients receive only
 * the range their own scouting has earned. Deriving the class from the public
 * season seed would let anyone regenerate it and read the answers.
 */
export function boardViews(board, seats = ['OC', 'DC'], reveal = false) {
  const views = {};
  for (const seat of seats) {
    const mine = seat === 'OC' ? 'offense' : 'defense';
    views[seat] = board.map((p) => scoutReport(
      // You get no read at all on the other coordinator's side of the ball.
      p.side === mine ? p : { ...p, scouted: 0 },
      { reveal }));
  }
  return { boardView: views };
}

export function openScouting(season, secret = null) {
  const used = new Set();
  for (const r of Object.values(season.rosters)) {
    for (const p of [...r.offense, ...r.defense]) used.add(p.name);
  }
  const draftSeed = secret || season.seed;
  const board = makeClass(draftSeed, season.year, used);
  return {
    ...season,
    draftSeed: secret ? undefined : draftSeed,
    board,
    ...boardViews(board),
    freeAgents: makeFreeAgents(draftSeed, season.year, used),
    scoutLeft: { OC: SCOUT_POINTS, DC: SCOUT_POINTS },
    advocacy: { OC: ADVOCACY, DC: ADVOCACY },
    draftBoard: { OC: [], DC: [] },
    signed: {},
    draftRoom: null,
  };
}

/** Spend a look on a prospect. Coordinators scout their own side only. */
export function useScout(season, seat, prospectId) {
  const left = season.scoutLeft?.[seat] ?? 0;
  if (left <= 0) return season;
  const before = season.board;
  const board = scout(before, prospectId, seat);
  if (board.every((p, i) => p.scouted === before[i].scouted)) return season;
  return {
    ...season, board,
    ...boardViews(board),
    scoutLeft: { ...season.scoutLeft, [seat]: left - 1 },
  };
}

/** Put a prospect on your own board — the shortlist you will argue for. */
export function toggleBoard(season, seat, prospectId) {
  const side = seat === 'OC' ? 'offense' : 'defense';
  const p = (season.boardView?.[seat] || []).find((x) => x.id === prospectId);
  if (!p || p.side !== side) return season;
  const cur = season.draftBoard?.[seat] || [];
  const next = cur.includes(prospectId)
    ? cur.filter((i) => i !== prospectId)
    : (cur.length >= BOARD_MAX ? cur : [...cur, prospectId]);
  return { ...season, draftBoard: { ...season.draftBoard, [seat]: next } };
}

/** Sign one veteran, per coordinator, for their own unit. */
export function signFreeAgent(season, seat, faId) {
  const side = seat === 'OC' ? 'offense' : 'defense';
  if (season.signed?.[seat]) return season;
  const fa = (season.freeAgents || []).find((f) => f.id === faId);
  if (!fa || fa.side !== side) return season;
  const { roster } = addToRoster(season.rosters[season.userTeam], fa);
  return {
    ...season,
    rosters: { ...season.rosters, [season.userTeam]: roster },
    freeAgents: season.freeAgents.filter((f) => f.id !== faId),
    signed: { ...season.signed, [seat]: fa },
  };
}

/**
 * Run the whole draft. Your club takes whoever each coordinator has queued for
 * their side; every other club picks for itself.
 */
/* ------------------------------------------------------------ draft room */

/** Open the room. Nothing is picked yet; the clock is on the first selection. */
export function startDraft(season) {
  return {
    ...season,
    draftRoom: {
      order: draftOrder(season),
      cursor: 0,
      picks: [],              // every selection made, league wide
      pitch: {},              // advocacy spent on the pick currently on the clock
      lastPick: null,
    },
  };
}

export const onTheClock = (season) => {
  const r = season.draftRoom;
  return r && r.cursor < r.order.length ? r.order[r.cursor] : null;
};
export const isOurPick = (season) => onTheClock(season)?.team === season.userTeam;

/** Spend advocacy on a prospect for the pick currently on the clock. */
export function advocate(season, seat, prospectId, amount = 1) {
  const room = season.draftRoom;
  if (!room || !isOurPick(season)) return season;
  const left = season.advocacy?.[seat] ?? 0;
  const amt = Math.max(1, Math.min(left, Number(amount) || 1));
  if (left < 1) return season;
  const side = seat === 'OC' ? 'offense' : 'defense';
  const p = (season.boardView?.[seat] || []).find((x) => x.id === prospectId)
    || (season.board || []).find((x) => x.id === prospectId);
  if (!p || p.side !== side) return season;
  if (room.picks.some((x) => x.id === prospectId)) return season;   // already gone
  return {
    ...season,
    advocacy: { ...season.advocacy, [seat]: left - amt },
    draftRoom: { ...room,
      pitch: { ...room.pitch, [prospectId]: (room.pitch[prospectId] || 0) + amt },
      pitchBy: { ...(room.pitchBy || {}), [prospectId]: seat } },
  };
}

/**
 * Run selections until our club is on the clock again, or the draft ends.
 * Every other club picks for itself; ours goes through the general manager,
 * who weighs whatever advocacy was spent.
 */
export function runPicks(season, opts = {}) {
  const room = season.draftRoom;
  if (!room) return season;
  const rosters = JSON.parse(JSON.stringify(season.rosters));
  const taken = new Set(room.picks.map((p) => p.id));
  let available = (season.board || []).filter((p) => !taken.has(p.id));
  const picks = [...room.picks];
  let cursor = room.cursor;
  let pitch = { ...room.pitch };
  let pitchBy = { ...(room.pitchBy || {}) };
  let lastPick = room.lastPick;
  let ours = 0;

  while (cursor < room.order.length && available.length) {
    const slot = room.order[cursor];
    const mine = slot.team === season.userTeam;
    // Stop at our pick unless we were told to make it.
    if (mine && !(opts.makeOurs && ours === 0)) break;

    const rng = mulberry32(hashSeed(`${season.seed}:pick:${slot.overall}`));
    let chosen, gmBoard = null;
    if (mine) {
      const res = makePick(available, rosters[slot.team], season.seed, rng, pitch);
      chosen = res.pick;
      gmBoard = res.board.map((b) => ({ id: b.p.id, name: b.p.name, pos: b.p.pos }));
      ours++;
    } else {
      chosen = cpuPick(available, rosters[slot.team], rng);
    }

    available = available.filter((p) => p.id !== chosen.id);
    const res = addToRoster(rosters[slot.team], { ...chosen, draftedIn: season.year });
    rosters[slot.team] = res.roster;
    const entry = {
      id: chosen.id, name: chosen.name, pos: chosen.pos, side: chosen.side,
      school: chosen.school, team: slot.team, round: slot.round, overall: slot.overall,
      mine, rating: mine ? chosen.rating : null,
      started: mine ? res.kept : null,
      advocated: pitch[chosen.id] || 0,
      advocatedBy: pitchBy[chosen.id] || null,
    };
    picks.push(entry);
    if (mine) {
      lastPick = { ...entry, gmBoard, spent: Object.values(pitch).reduce((a, b) => a + b, 0) };
      pitch = {}; pitchBy = {};    // advocacy does not carry to the next pick
    }
    cursor++;
    if (mine) break;
  }

  const done = cursor >= room.order.length || !available.length;
  return {
    ...season, rosters,
    draftRoom: { ...room, cursor, picks, pitch, pitchBy, lastPick, done },
    ...(done ? finishDraft(season, picks) : {}),
  };
}

function finishDraft(season, picks) {
  const mine = picks.filter((p) => p.mine);
  const boarded = [...(season.draftBoard?.OC || []), ...(season.draftBoard?.DC || [])];
  const missed = boarded
    .filter((id) => !mine.some((m) => m.id === id))
    .map((id) => {
      const p = (season.board || []).find((x) => x.id === id);
      const by = picks.find((x) => x.id === id);
      return p ? { id, name: p.name, pos: p.pos, side: p.side,
        trueGrade: p.rating, takenBy: by?.team || null, overall: by?.overall || null } : null;
    })
    .filter(Boolean);
  return { draftResult: mine, missedTargets: missed };
}

/**
 * Fold the season that just ended into a career record. Interviews read this,
 * so one good year reads differently from four of them — and a coordinator who
 * has been quietly excellent on a bad club has something to point at.
 */
export function archiveSeason(season, seats = ['OC', 'DC']) {
  const rec = record(season);
  const champ = season.champion === season.userTeam;
  const madePlayoffs = !!season.playoffs && [
    ...(season.playoffs.seeds?.N || []), ...(season.playoffs.seeds?.S || []),
  ].some((s) => s.id === season.userTeam);

  const years = {};
  for (const seat of seats) {
    const r = resume(season, seat);
    years[seat] = {
      year: season.year,
      honours: staffHonours(season.awards, seat, season.userTeam).map((h) => h.key),
      team: season.userTeam,
      w: rec.w, l: rec.l, t: rec.t,
      madePlayoffs, champion: champ,
      ypp: +r.stats.ypp.toFixed(2),
      pointsPerGame: +r.stats.pointsPerGame.toFixed(1),
      third: +r.stats.third.toFixed(3),
      ranks: r.ranks,
      gamesCalled: r.gamesCalled,
      gamesPlayed: r.gamesPlayed,
    };
  }
  const career = { ...(season.career || {}) };
  for (const seat of seats) career[seat] = [...(career[seat] || []), years[seat]];
  return career;
}

/**
 * A coordinator's whole body of work. Interviews weigh the best years most —
 * a hiring club forgives a bad year on a bad roster, but it wants to see that
 * you have done it more than once.
 */
export function careerResume(season, seat) {
  const years = [...(season.career?.[seat] || [])];
  const current = resume(season, seat);
  const unit = seat === 'OC' ? 'offense' : 'defense';
  if (!years.length) {
    return { seasons: 1, years: [], current,
      bestRank: current.ranks.points, topFives: current.ranks.points <= 5 ? 1 : 0,
      totalW: current.record.w, totalL: current.record.l,
      playoffs: 0, rings: 0, calledPct: current.gamesPlayed
        ? current.gamesCalled / current.gamesPlayed : 0, unit };
  }
  const totalW = years.reduce((a, y) => a + y.w, 0) + current.record.w;
  const totalL = years.reduce((a, y) => a + y.l, 0) + current.record.l;
  const ranks = [...years.map((y) => y.ranks.points), current.ranks.points];
  const called = years.reduce((a, y) => a + y.gamesCalled, 0) + current.gamesCalled;
  const played = years.reduce((a, y) => a + y.gamesPlayed, 0) + current.gamesPlayed;
  return {
    seasons: years.length + 1,
    years, current, unit,
    bestRank: Math.min(...ranks),
    topFives: ranks.filter((r) => r <= 5).length,
    totalW, totalL,
    playoffs: years.filter((y) => y.madePlayoffs).length,
    rings: years.filter((y) => y.champion).length,
    calledPct: played ? called / played : 0,
  };
}

/** Roll the calendar forward and go again. */
export function nextSeason(season, seats = ['OC', 'DC']) {
  const career = archiveSeason(season, seats);
  const ids = TEAMS.map((t) => t.id);
  // Everyone gets a year older, and the rosters you built carry forward.
  const rosters = Object.fromEntries(ids.map((id) => {
    const experience = {
      _teamGames: season.results.filter((r) => r.final && (r.home === id || r.away === id)).length,
      _detailed: id === season.userTeam,
    };
    if (id === season.userTeam) Object.assign(experience,
      playerSeasonTotals(season, 'offense'), playerSeasonTotals(season, 'defense'));
    return [id, ageRoster(season.rosters[id], season.seed, season.year, experience)];
  }));
  return hydrate({
    seed: `${season.seed}-${season.year + 1}`,
    year: season.year + 1,
    userTeam: season.userTeam,
    week: 1, phase: 'regular', results: [], playoffs: null,
    customPlays: season.customPlays || [],
    customDefenses: season.customDefenses || [],
    filmBank: season.filmBank,
    filmVersion: season.filmVersion,
    filmOverlays: season.filmOverlays,
    rosters,
    career,
    careerYears: (season.careerYears || 1) + 1,
  });
}

export { interviewQuestions };

/* ------------------------------------------------------------ the résumé */

/**
 * What a hiring team would actually look at: your unit's rank in the league,
 * the record, and how much of it you called yourself.
 */
export function resume(season, seat) {
  const reg = season.results.filter((r) => !r.playoff);
  const stats = seasonUnitStats(reg, TEAMS.map((t) => t.id));
  const ranks = unitRanks(stats);
  const mine = stats.find((s) => s.id === season.userTeam);
  const unit = seat === 'OC' ? 'offense' : 'defense';
  const rec = record(season);
  const called = reg.filter((r) => r.played && (r.home === season.userTeam || r.away === season.userTeam)).length;

  return {
    unit,
    record: rec,
    gamesCalled: called,
    gamesPlayed: rec.w + rec.l + rec.t,
    stats: mine[unit],
    ranks: {
      ypp: ranks[unit].ypp[season.userTeam],
      points: ranks[unit].points[season.userTeam],
      third: ranks[unit].third[season.userTeam],
      turnovers: ranks[unit].turnovers[season.userTeam],
    },
    league: { stats, ranks },
  };
}
