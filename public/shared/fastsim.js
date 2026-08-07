// fastsim.js — a whole game in a fraction of a millisecond.
// The other fifteen games every week can't be played snap by snap, but they
// still have to produce the unit numbers that feed the résumé. Calibrated
// against the detailed engine: ~19 points, ~5.4 yards per play, ~63 plays,
// ~41% on third down per team.
import { mulberry32, hashSeed } from './engine.js';

const HOME_FIELD = 1.6;     // points
const LEAGUE_YPP = 5.42;
const LEAGUE_PLAYS = 63;
// Offensive ratings sit above defensive ones by construction, so a raw
// off-minus-def edge is not centred on zero. Subtract the league-neutral
// value or every team looks above average.
const NEUTRAL_EDGE = 1.7;

function gauss(rng, mean, sd) {
  let u = 0, v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return mean + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

/**
 * One side of the ball. `edge` is this offense's strength minus the opposing
 * defense's, in rating points.
 */
function unit(rawEdge, rng, extra = 0) {
  const edge = rawEdge - NEUTRAL_EDGE;
  const plays = Math.round(clamp(gauss(rng, LEAGUE_PLAYS, 5.5), 45, 82));
  const ypp = clamp(gauss(rng, LEAGUE_YPP + edge * 0.11, 1.15), 2.2, 9.5);
  const yards = Math.round(plays * ypp);
  const third = clamp(gauss(rng, 0.408 + edge * 0.010, 0.10), 0.10, 0.75);
  const turnovers = Math.max(0, Math.round(gauss(rng, 1.35 - edge * 0.02, 1.05)));
  const success = clamp(gauss(rng, 0.45 + edge * 0.005, 0.06), 0.22, 0.68);
  const explosive = clamp(gauss(rng, 0.054 + edge * 0.0012, 0.022), 0.005, 0.16);

  // Points follow from yards and finishing rather than an independent roll —
  // a team with 430 yards and no turnovers should not post 6 points. The
  // small direct talent term is red-zone finishing, which yardage misses;
  // without it season records compress to everyone going 8-9.
  const raw = (yards / 100) * 5.0 + third * 14 - turnovers * 3.3 + edge * 0.66 + extra;
  const points = Math.max(0, Math.round(clamp(gauss(rng, raw, 7.6), 0, 62)));

  const rushShare = clamp(gauss(rng, 0.36, 0.09), 0.15, 0.62);
  return {
    plays, yards, ypp: +ypp.toFixed(2), points,
    rushYards: Math.round(yards * rushShare * 0.78),
    passYards: Math.round(yards * (1 - rushShare * 0.78)),
    third: +third.toFixed(3), success: +success.toFixed(3),
    explosive: +explosive.toFixed(3), turnovers,
  };
}

/**
 * Simulate one game. `strength` maps team id to { off, def }.
 * Deterministic from (seed, gameId) so a week can be recomputed if needed.
 */
export function simGame(gameId, home, away, strength, seed = '') {
  const rng = mulberry32(hashSeed(`${seed}:${gameId}`));
  const h = strength[home], a = strength[away];

  const hUnit = unit(h.off - a.def, rng, HOME_FIELD);
  const aUnit = unit(a.off - h.def, rng);

  let homeScore = hUnit.points, awayScore = aUnit.points;
  // Ties are rare — overtime settles most of them.
  if (homeScore === awayScore && rng() < 0.94) {
    if (rng() < 0.5) homeScore += 3; else awayScore += 3;
  }

  return {
    id: gameId, home, away, homeScore, awayScore, final: true, simulated: true,
    homeStats: { ...hUnit, points: homeScore, pointsAllowed: awayScore },
    awayStats: { ...aUnit, points: awayScore, pointsAllowed: homeScore },
  };
}

/** Run every unplayed game in a week. */
export function simWeek(games, strength, seed) {
  return games.map((g) => simGame(g.id, g.home, g.away, strength, seed));
}

/**
 * Season-long unit totals per team, which is what the résumé is built from.
 * Both fast-simulated and fully played games land in the same shape.
 */
export function seasonUnitStats(results, teamIds) {
  const blank = () => ({ games: 0, plays: 0, yards: 0, points: 0, third: 0, turnovers: 0, explosive: 0 });
  const rows = Object.fromEntries(teamIds.map((id) => [id, { id, offense: blank(), defense: blank() }]));

  for (const r of results) {
    if (!r.final || !r.homeStats) continue;
    for (const [side, mine, theirs] of [[r.home, r.homeStats, r.awayStats], [r.away, r.awayStats, r.homeStats]]) {
      const row = rows[side];
      if (!row) continue;
      for (const [unitKey, st] of [['offense', mine], ['defense', theirs]]) {
        const u = row[unitKey];
        u.games++; u.plays += st.plays; u.yards += st.yards;
        u.points += st.points; u.third += st.third;
        u.turnovers += st.turnovers; u.explosive += st.explosive;
      }
    }
  }

  return Object.values(rows).map((row) => ({
    id: row.id,
    offense: finalise(row.offense),
    defense: finalise(row.defense),
  }));
}

function finalise(u) {
  const g = Math.max(1, u.games);
  return {
    games: u.games,
    ypp: u.plays ? u.yards / u.plays : 0,
    pointsPerGame: u.points / g,
    third: u.third / g,
    turnoversPerGame: u.turnovers / g,
    explosive: u.explosive / g,
    yards: u.yards, points: u.points, plays: u.plays,
  };
}

/**
 * League ranks, 1 = best. Offense wants more; defense wants less.
 * These are the numbers a hiring team actually looks at.
 */
export function unitRanks(stats) {
  const rank = (rows, key, unitKey, lowerIsBetter) => {
    const sorted = [...rows].sort((a, b) => lowerIsBetter
      ? a[unitKey][key] - b[unitKey][key]
      : b[unitKey][key] - a[unitKey][key]);
    const out = {};
    sorted.forEach((r, i) => { out[r.id] = i + 1; });
    return out;
  };
  return {
    offense: {
      ypp: rank(stats, 'ypp', 'offense', false),
      points: rank(stats, 'pointsPerGame', 'offense', false),
      third: rank(stats, 'third', 'offense', false),
      turnovers: rank(stats, 'turnoversPerGame', 'offense', true),
    },
    defense: {
      ypp: rank(stats, 'ypp', 'defense', true),
      points: rank(stats, 'pointsPerGame', 'defense', true),
      third: rank(stats, 'third', 'defense', true),
      turnovers: rank(stats, 'turnoversPerGame', 'defense', false),
    },
  };
}
