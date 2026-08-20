// film.js — compact, persistent opponent scouting between games.
//
// Full snap logs live under an individual game document. Carrying all of them
// inside a season would eventually exceed Firestore's document limit, so the
// season keeps only counts and outcome totals by situation and call.
import {
  cpuDefensiveCall, cpuOffensiveCall, distBucket, emptyTendencies,
  hashSeed, mulberry32,
} from './engine.js';
import { OFFENSE, OFF_BY_ID, DEF_BY_ID } from './playbook.js';
import { FORMATIONS, runSpots } from './designer.js';

export const FILM_OVERLAY_COST = 3;
export const FILM_GAME_GRANT = 3;
export const FILM_SIM_GRANT = 2;

export const FILM_SITUATIONS = [
  { key: '1-10', label: '1st & 10' },
  { key: '2-short', label: '2nd & short' },
  { key: '2-med', label: '2nd & medium' },
  { key: '2-long', label: '2nd & long' },
  { key: '3-short', label: '3rd & short' },
  { key: '3-med', label: '3rd & medium' },
  { key: '3-long', label: '3rd & long' },
  { key: '4-short', label: '4th & short' },
  { key: '4-med', label: '4th & medium' },
  { key: '4-long', label: '4th & long' },
];

export function filmSituation(state) {
  return state.down === 1 ? '1-10' : `${state.down}-${distBucket(state.distance)}`;
}

const clone = (value) => JSON.parse(JSON.stringify(value || {}));

function addSample(book, teamId, unit, state, callId, outcome = null) {
  if (!teamId || !callId) return;
  const situation = filmSituation(state);
  const calls = (((book[teamId] ||= {})[unit] ||= {})[situation] ||= {});
  const row = (calls[callId] ||= { n: 0, yards: 0, wins: 0, graded: 0 });
  row.n += 1;
  if (outcome) {
    const yards = outcome.yards || 0;
    row.yards += yards;
    row.wins += state.down === 1 ? yards >= state.distance * 0.4
      : state.down === 2 ? yards >= state.distance * 0.6 : yards >= state.distance;
    row.graded += 1;
  }
}

export function mergeFilmBooks(base, addition) {
  const out = clone(base);
  for (const [teamId, team] of Object.entries(addition || {})) {
    for (const unit of ['offense', 'defense']) {
      for (const [situation, calls] of Object.entries(team[unit] || {})) {
        const target = (((out[teamId] ||= {})[unit] ||= {})[situation] ||= {});
        const count = (row) => typeof row === 'number' ? row : row?.n || 0;
        const heldTotal = target._total ?? Object.entries(target)
          .filter(([key]) => key !== '_total').reduce((sum, [, row]) => sum + count(row), 0);
        const incomingTotal = calls._total ?? Object.entries(calls)
          .filter(([key]) => key !== '_total').reduce((sum, [, row]) => sum + count(row), 0);
        target._total = heldTotal + incomingTotal;
        for (const [callId, incoming] of Object.entries(calls || {})) {
          if (callId === '_total') continue;
          const held = target[callId];
          target[callId] = (typeof held === 'number' ? held : held?.n || 0)
            + (typeof incoming === 'number' ? incoming : incoming?.n || 0);
        }
      }
    }
  }
  // The report only needs a team's most common calls. Bounding every bucket
  // keeps a multi-year career comfortably below Firestore's document limit.
  for (const team of Object.values(out)) {
    for (const unit of ['offense', 'defense']) {
      for (const calls of Object.values(team[unit] || {})) {
        const count = (row) => typeof row === 'number' ? row : row?.n || 0;
        const total = calls._total;
        const keep = Object.entries(calls).filter(([key]) => key !== '_total')
          .sort((a, b) => count(b[1]) - count(a[1])).slice(0, 8);
        for (const key of Object.keys(calls)) delete calls[key];
        calls._total = total;
        for (const [key, row] of keep) calls[key] = row;
      }
    }
  }
  return out;
}

/** Calls from a detailed game, attributed to the team that made each call. */
export function filmFromPlays(plays, { us, them }) {
  const out = {};
  for (const p of plays || []) {
    if (!p.outcome || p.special || !p.offId
      || (p.outcome.penalty && p.outcome.penalty.replay)) continue;
    const offense = p.possession === 'US' ? us : them;
    const defense = p.possession === 'US' ? them : us;
    addSample(out, offense, 'offense', p, p.offId, p.outcome);
    addSample(out, defense, 'defense', p, p.defId, p.outcome);
  }
  return out;
}

/** A stable personality used by both advance scouting and the actual CPU. */
export function teamOffensiveIdentity(seed, teamId) {
  const rng = mulberry32(hashSeed(`${seed}:identity:${teamId}:offense`));
  const builtIns = OFFENSE.filter((p) => !p.custom);
  const byFamily = Object.groupBy
    ? Object.groupBy(builtIns, (p) => p.family)
    : builtIns.reduce((a, p) => { (a[p.family] ||= []).push(p); return a; }, {});
  const playLeans = {};
  for (const plays of Object.values(byFamily)) {
    const favorite = plays[Math.floor(rng() * plays.length)];
    if (favorite) playLeans[favorite.id] = 0.075 + rng() * 0.045;
  }
  return { runLean: (rng() - 0.45) * 1.8, playLeans };
}

const SITUATION_SAMPLE = [
  [0.40, { down: 1, distance: 10 }],
  [0.55, { down: 2, distance: 2 }],
  [0.71, { down: 2, distance: 6 }],
  [0.81, { down: 2, distance: 11 }],
  [0.88, { down: 3, distance: 2 }],
  [0.95, { down: 3, distance: 6 }],
  [0.99, { down: 3, distance: 11 }],
  [1.00, { down: 4, distance: 2 }],
];

function sampleState(rng) {
  const roll = rng();
  const situation = SITUATION_SAMPLE.find(([limit]) => roll <= limit)?.[1] || SITUATION_SAMPLE[0][1];
  return {
    ...situation,
    ballOn: 15 + Math.floor(rng() * 75),
    quarter: 1 + Math.floor(rng() * 4),
    clock: 60 + Math.floor(rng() * 820),
    score: { us: Math.floor(rng() * 28), them: Math.floor(rng() * 28) },
  };
}

/** Compact call samples for games resolved by fastsim rather than snap-by-snap. */
export function simulatedGameFilm(seed, gameId, home, away, homePlays = 63, awayPlays = 63) {
  const out = {};
  const sample = (offense, defense, count) => {
    const rng = mulberry32(hashSeed(`${seed}:${gameId}:film:${offense}`));
    const identity = teamOffensiveIdentity(seed, offense);
    const tendencies = emptyTendencies();
    for (let i = 0; i < count; i += 1) {
      const state = sampleState(rng);
      const offId = cpuOffensiveCall(state, tendencies, rng, identity);
      const defId = cpuDefensiveCall(state, tendencies, rng);
      addSample(out, offense, 'offense', state, offId);
      addSample(out, defense, 'defense', state, defId);
    }
  };
  sample(home, away, Math.max(1, Math.round(homePlays)));
  sample(away, home, Math.max(1, Math.round(awayPlays)));
  return out;
}

export function filmRows(book, teamId, unit, situation) {
  const calls = book?.[teamId]?.[unit]?.[situation] || {};
  const count = (row) => typeof row === 'number' ? row : row?.n || 0;
  const total = calls._total ?? Object.entries(calls).filter(([key]) => key !== '_total')
    .reduce((sum, [, row]) => sum + count(row), 0);
  return Object.entries(calls).filter(([callId]) => callId !== '_total').map(([callId, row]) => ({
    callId,
    name: (unit === 'offense' ? OFF_BY_ID[callId] : DEF_BY_ID[callId])?.name || callId,
    n: count(row),
    frequency: total ? count(row) / total : 0,
    ypp: typeof row === 'object' && row.graded ? row.yards / row.graded : null,
    success: typeof row === 'object' && row.graded ? row.wins / row.graded : null,
  })).sort((a, b) => b.n - a.n);
}

export function hasCall(book, teamId, unit, callId) {
  return Object.values(book?.[teamId]?.[unit] || {})
    .some((calls) => !!calls?.[callId]);
}

/** Route/run geometry used as the translucent opponent layer in the designer. */
export function opponentDiagram(callId) {
  const play = OFF_BY_ID[callId];
  if (!play) return null;
  const pers = FORMATIONS[play.pers] ? play.pers : '11';
  const spots = play.family === 'run' ? runSpots(pers) : FORMATIONS[pers].spots;
  const start = (spot) => spots[spot] || FORMATIONS['11'].spots[spot] || [26.6, 0];
  const route = (spot, ...points) => [start(spot), ...points];
  const diagrams = {
    slants: { WR1: route('WR1', [16, 7]), WR2: route('WR2', [38, 7]), WR3: route('WR3', [28, 6]) },
    stick: { TE1: route('TE1', [35, 6], [39, 6]), WR3: route('WR3', [17, 5]), RB1: route('RB1', [20, 1]) },
    hitches: { WR1: route('WR1', [3, 7], [8, 6]), WR2: route('WR2', [50, 7], [45, 6]), WR3: route('WR3', [17, 6]) },
    spacing: { WR1: route('WR1', [10, 5]), WR2: route('WR2', [43, 5]), WR3: route('WR3', [22, 4]), TE1: route('TE1', [31, 4]) },
    rbscreen: { RB1: route('RB1', [20, -1], [14, 3], [8, 7]), WR1: route('WR1', [3, 9]), WR2: route('WR2', [50, 12]) },
    tunnel: { WR3: route('WR3', [21, 0], [25, 4]), WR1: route('WR1', [3, 12]), WR2: route('WR2', [50, 14]) },
    mesh: { WR1: route('WR1', [12, 5], [34, 5]), WR2: route('WR2', [41, 6], [18, 6]), WR3: route('WR3', [20, 12]), TE1: route('TE1', [35, 10]) },
    flood: { WR1: route('WR1', [4, 18]), TE1: route('TE1', [43, 10], [51, 12]), WR2: route('WR2', [50, 4]), RB1: route('RB1', [40, 1]) },
    dagger: { WR1: route('WR1', [3, 22]), WR2: route('WR2', [49, 18], [29, 18]), TE1: route('TE1', [35, 8]) },
    smash: { WR1: route('WR1', [3, 6]), WR2: route('WR2', [50, 6]), WR3: route('WR3', [17, 10], [8, 18]), TE1: route('TE1', [35, 10], [45, 18]) },
    ycross: { TE1: route('TE1', [31, 7], [15, 14]), WR1: route('WR1', [3, 20]), WR2: route('WR2', [42, 12]), WR3: route('WR3', [23, 5]) },
    curlflat: { WR1: route('WR1', [3, 11], [9, 9]), WR2: route('WR2', [50, 11], [44, 9]), RB1: route('RB1', [16, 1]), TE1: route('TE1', [35, 7]) },
    comebacks: { WR1: route('WR1', [3, 16], [9, 12]), WR2: route('WR2', [50, 16], [44, 12]), WR3: route('WR3', [17, 12], [22, 10]) },
    paboot: { TE1: route('TE1', [40, 7], [48, 11]), WR1: route('WR1', [3, 20]), WR2: route('WR2', [42, 13]), RB1: route('RB1', [34, 0]) },
    padig: { WR1: route('WR1', [3, 18], [24, 18]), WR2: route('WR2', [50, 20]), TE1: route('TE1', [35, 9]) },
    verts: { WR1: route('WR1', [3, 28]), WR2: route('WR2', [50, 28]), WR3: route('WR3', [18, 27]), TE1: route('TE1', [35, 27]) },
    postwheel: { WR1: route('WR1', [3, 15], [23, 27]), RB1: route('RB1', [37, 2], [48, 20]), WR2: route('WR2', [50, 25]) },
    pashot: { WR1: route('WR1', [3, 14], [24, 28]), WR2: route('WR2', [50, 27]), TE1: route('TE1', [35, 14]), RB1: route('RB1', [39, 1]) },
  };
  const runs = {
    iz: { RB1: route('RB1', [27, 2], [28, 9]) },
    oz: { RB1: route('RB1', [34, -1], [42, 4], [49, 10]) },
    power: { RB1: route('RB1', [25, -1], [22, 7]) },
    counter: { RB1: route('RB1', [31, -4], [22, 1], [18, 8]) },
    toss: { RB1: route('RB1', [38, -3], [48, 3], [51, 10]) },
    draw: { QB: [[26.6, 0], [26.6, 7]] },
    trap: { RB1: route('RB1', [27, 0], [31, 7]) },
    sneak: { QB: [[26.6, 0], [26.6, 3]] },
  };
  return { play, spots, paths: diagrams[callId] || runs[callId] || {} };
}
