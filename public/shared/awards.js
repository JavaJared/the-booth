// awards.js — the honours handed out when the year ends.
//
// Player stats are only stored for the club you coach, so a league-wide vote
// has to reconstruct rivals from what the season does record: every team's
// unit totals, its record, and its roster. That is enough to find a genuine
// MVP without keeping seventeen box scores for 1,700 players.
import { TEAMS, TEAM_BY_ID, fullName, sortedStandings } from './league.js';
import { seasonUnitStats, unitRanks } from './fastsim.js';
import { depthChart } from './depth.js';
import { mulberry32, hashSeed } from './engine.js';
import { FIRST, LAST } from './names.js';

const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

/**
 * Approximate a club's leading players from its unit production. A team that
 * threw for 4,600 yards had someone throw them; this works out who, and how
 * the year would have looked on his line.
 */
function leadersFor(teamId, roster, unit, seed) {
  const rng = mulberry32(hashSeed(`${seed}:awards:${teamId}`));
  const wob = (sd) => 1 + (rng() - 0.5) * sd;
  const off = unit.offense, def = unit.defense;
  const games = Math.max(1, off.games);

  const best = (list, pos) => [...list.filter((p) => p.pos === pos)]
    .sort((a, b) => b.rating - a.rating)[0];

  const qb = best(roster.offense, 'QB');
  const rb = best(roster.offense, 'RB');
  const wr = best(roster.offense, 'WR');
  const te = best(roster.offense, 'TE');
  const edge = best(roster.defense, 'EDGE');
  const lb = best(roster.defense, 'LB');
  const cb = best(roster.defense, 'CB');
  const saf = best(roster.defense, 'S');

  // off.yards is the whole offence for the season. Split it the way a real one
  // splits, and cap the quarterback's share so nobody posts 6,500 yards.
  // Everything below is built from PER GAME rates and then multiplied by the
  // games actually played, so a week four leader shows week four numbers.
  const perGame = {
    passYards: clamp(off.yards / games * 0.62, 90, 295),
    rushYards: clamp(off.yards / games * 0.38, 50, 190),
    tds: off.points / games / 7.4,
  };
  const passYards = perGame.passYards * games;
  const rushYards = perGame.rushYards * games;
  const tds = perGame.tds * games;

  // A quarterback genuinely accounts for nearly all of his unit's passing.
  // Nobody else does: a leading rusher is roughly half a run game, a top
  // receiver about a quarter of the targets, and a pass rusher's sacks are his
  // own rate rather than a slice of the team's defensive output.
  const rate = (base, perG) => Math.max(0, perG) * games;

  const out = [];
  const add = (p, side, stats, headline) => {
    if (!p) return;
    out.push({ teamId, side, pos: p.pos, name: p.name, rating: p.rating,
      age: p.age, rookie: p.draftedIn != null, stats, headline });
  };

  // Rookies rarely lead a club, so the pool needs the best first year player
  // at each spot as well as the best player overall.
  const bestRookie = (list, side) => {
    const r = [...list].filter((p) => p.draftedIn != null)
      .sort((a, b) => b.rating - a.rating)[0];
    if (!r) return;
    // A first year player is rarely the club's whole production. Cap his share
    // so a rookie quarterback does not post a better line than the veteran
    // starter whose numbers he is being derived from.
    const share = clamp((r.rating - 62) / 90, 0.06, 0.55);
    if (side === 'offense') {
      const stats = r.pos === 'QB'
        ? { passYards: Math.round(passYards * 0.9 * share), passTD: Math.round(tds * 0.55 * share),
            int: Math.max(0, Math.round(games * 0.9)) }
        : r.pos === 'RB'
          ? { rushYards: Math.round(rushYards * 0.55 * share), rushTD: Math.round(tds * 0.2 * share) }
          : { recYards: Math.round(passYards * 0.22 * share), recTD: Math.round(tds * 0.15 * share) };
      const headline = stats.passYards
        ? (x) => `${x.passYards} yards, ${x.passTD} TD, ${x.int} INT`
        : stats.rushYards ? (x) => `${x.rushYards} rushing, ${x.rushTD} TD`
        : (x) => `${x.recYards} receiving, ${x.recTD} TD`;
      out.push({ teamId, side, pos: r.pos, name: r.name, rating: r.rating,
        age: r.age, rookie: true, stats, headline });
    } else {
      const stats = { tackles: Math.round(games * (4.2 * share + 0.9)),
        sacks: Math.round(games * (0.30 + stopsFor * 0.05) * share * 2) / 2,
        ints: Math.round(games * (0.15 + stopsFor * 0.03) * share) };
      out.push({ teamId, side, pos: r.pos, name: r.name, rating: r.rating,
        age: r.age, rookie: true, stats,
        headline: (x) => [x.sacks ? `${x.sacks} sacks` : null, `${x.tackles} tackles`,
          x.ints ? `${x.ints} INT` : null].filter(Boolean).join(', ') });
    }
  };

  add(qb, 'offense', {
    passYards: Math.round(clamp(passYards * 0.94 * wob(0.08), 900, 5400)),
    passTD: Math.round(tds * 0.62 * wob(0.18)),
    int: Math.max(0, Math.round(games * 0.75 * (1 - (qb?.rating - 75) / 90) * wob(0.3))),
  }, (s) => `${s.passYards} yards, ${s.passTD} TD, ${s.int} INT`);

  add(rb, 'offense', {
    rushYards: Math.round(rushYards * 0.58 * wob(0.14)),
    rushTD: Math.round(tds * 0.22 * wob(0.3)),
  }, (s) => `${s.rushYards} rushing, ${s.rushTD} TD`);

  add(wr, 'offense', {
    recYards: Math.round(passYards * 0.28 * wob(0.16)),
    recTD: Math.round(tds * 0.20 * wob(0.35)),
  }, (s) => `${s.recYards} receiving, ${s.recTD} TD`);

  add(te, 'offense', {
    recYards: Math.round(passYards * 0.16 * wob(0.18)),
    recTD: Math.round(tds * 0.12 * wob(0.4)),
  }, (s) => `${s.recYards} receiving, ${s.recTD} TD`);

  // How good the defence was, as a modest nudge to individual rates rather
  // than a pool to be divided up. A dominant unit produces good players; it
  // does not hand one man fifteen sacks by week four.
  const stops = clamp((5.6 - def.ypp) * 2.2 + (24 - def.pointsPerGame) * 0.14, -1.6, 2.4);
  const stopsFor = stops;
  const quality = (p) => ((p?.rating || 72) - 74) / 22;   // roughly -1.3 .. +1.1

  // Per game rates, taken from what real leaders actually average.
  add(edge, 'defense', {
    sacks: Math.round(rate(0, (0.52 + stops * 0.09 + quality(edge) * 0.16) * wob(0.22)) * 2) / 2,
    tackles: Math.round(rate(0, 3.3 * wob(0.2))),
  }, (s) => `${s.sacks} sacks, ${s.tackles} tackles`);

  add(lb, 'defense', {
    tackles: Math.round(rate(0, (8.6 + quality(lb) * 1.2) * wob(0.13))),
    sacks: Math.round(rate(0, (0.14 + stops * 0.03) * wob(0.45)) * 2) / 2,
  }, (s) => `${s.tackles} tackles, ${s.sacks} sacks`);

  add(cb, 'defense', {
    ints: Math.round(rate(0, (0.155 + stops * 0.035 + quality(cb) * 0.055) * wob(0.4))),
    pbu: Math.round(rate(0, 1.05 * wob(0.3))),
  }, (s) => `${s.ints} interceptions, ${s.pbu} passes defended`);

  add(saf, 'defense', {
    ints: Math.round(rate(0, (0.125 + stops * 0.028) * wob(0.45))),
    tackles: Math.round(rate(0, (6.0 + quality(saf) * 0.9) * wob(0.16))),
  }, (s) => `${s.ints} interceptions, ${s.tackles} tackles`);

  bestRookie(roster.offense, 'offense');
  bestRookie(roster.defense, 'defense');
  return out;
}

/** How much a voter thinks a player was worth. */
function value(c, standings, ranks) {
  const row = standings.byId[c.teamId];
  const s = c.stats;
  // Scaled so a great year at each position lands in the same range. Raw
  // passing volume otherwise buries every rusher and receiver in the league.
  let v = 0;
  if (s.passYards) v = s.passYards / 88 + s.passTD * 1.5 - s.int * 1.1;
  else if (s.rushYards) v = s.rushYards / 26 + s.rushTD * 2.4;
  else if (s.recYards) v = s.recYards / 24 + s.recTD * 2.4;
  else if (s.sacks != null && s.sacks >= s.tackles / 12) v = s.sacks * 4.2 + s.tackles / 9;
  else if (s.ints != null) v = s.ints * 5.2 + (s.tackles || 0) / 10 + (s.pbu || 0) * 0.7;
  else v = (s.tackles || 0) / 7 + (s.sacks || 0) * 3.4;

  // Voters reward winning, and they reward the player's own quality.
  v += (row ? row.w : 8) * 0.55;
  v += (c.rating - 75) * 0.22;
  const unitRank = c.side === 'offense'
    ? ranks.offense.points[c.teamId] : ranks.defense.points[c.teamId];
  v += (33 - unitRank) * 0.16;
  return v;
}

/**
 * Everything voted on at the end of a season. Coordinator awards are decided
 * on unit rank rather than record, because a coordinator does not control the
 * other side of the ball.
 */
export function seasonAwards(season) {
  const reg = season.results.filter((r) => !r.playoff);
  if (!reg.length) return null;

  const ids = TEAMS.map((t) => t.id);
  const stats = seasonUnitStats(reg, ids);
  const ranks = unitRanks(stats);
  const standings = sortedStandings(reg);
  const byId = Object.fromEntries(stats.map((s) => [s.id, s]));

  // Build a candidate pool from every club.
  let pool = [];
  for (const id of ids) {
    const roster = season.rosters[id];
    if (!roster) continue;
    pool.push(...leadersFor(id, roster, byId[id], season.seed));
  }

  // Replace our own club's approximations with the real thing.
  const us = season.userTeam;
  const real = [];
  for (const side of ['offense', 'defense']) {
    for (const p of depthChart(season, side)) {
      if (!p.games) continue;
      const stats2 = side === 'offense'
        ? (p.att ? { passYards: p.passYards, passTD: p.passTD, int: p.int }
          : p.carries > p.rec ? { rushYards: p.rushYards, rushTD: p.rushTD }
          : p.rec ? { recYards: p.recYards, recTD: p.recTD } : null)
        : { tackles: p.tackles, sacks: p.sacks, ints: p.ints, pbu: p.pbu };
      if (!stats2) continue;
      const headline = side === 'offense'
        ? (p.att ? (s) => `${s.passYards} yards, ${s.passTD} TD, ${s.int} INT`
          : p.carries > p.rec ? (s) => `${s.rushYards} rushing, ${s.rushTD} TD`
          : (s) => `${s.recYards} receiving, ${s.recTD} TD`)
        : (s) => [s.sacks ? `${s.sacks} sacks` : null, `${s.tackles} tackles`,
            s.ints ? `${s.ints} INT` : null].filter(Boolean).join(', ');
      real.push({ teamId: us, side, pos: p.pos, name: p.name, rating: p.rating,
        age: p.age, rookie: p.rookie, stats: stats2, headline });
    }
  }
  pool = pool.filter((c) => c.teamId !== us).concat(real);

  const scored = pool.map((c) => ({ ...c, v: value(c, standings, ranks) }));
  const pick = (filter) => {
    const field = scored.filter(filter).sort((a, b) => b.v - a.v);
    return field.length ? { ...field[0], runnersUp: field.slice(1, 3) } : null;
  };

  // Rookies: only our own club is tracked precisely, so a rookie of the year
  // is drawn from players who arrived in the last draft.
  const isRookie = (c) => !!c.rookie;

  const mvp = pick(() => true);
  // The MVP is almost always the best offensive player, so OPOY goes to the
  // next man rather than reading out the same name twice. Compared by name and
  // club: pick() spreads into a new object, so identity comparison never held.
  const isMvp = (c) => mvp && c.name === mvp.name && c.teamId === mvp.teamId;
  const opoy = pick((c) => c.side === 'offense' && !isMvp(c));
  const dpoy = pick((c) => c.side === 'defense' && !isMvp(c));

  const awards = [
    { key: 'mvp', label: 'Most Valuable Player', winner: mvp },
    { key: 'opoy', label: 'Offensive Player of the Year', winner: opoy },
    { key: 'dpoy', label: 'Defensive Player of the Year', winner: dpoy },
    { key: 'oroy', label: 'Offensive Rookie of the Year',
      winner: pick((c) => c.side === 'offense' && isRookie(c)) },
    { key: 'droy', label: 'Defensive Rookie of the Year',
      winner: pick((c) => c.side === 'defense' && isRookie(c)) },
  ];

  // ---- staff awards
  const expected = (id) => {
    const s = season.strength[id];
    return 8.5 + ((s.off - 75) + (s.def - 74)) * 0.42;
  };
  const coachField = ids.map((id) => {
    const row = standings.byId[id];
    return { id, v: row.w - expected(id) + row.w * 0.18 };
  }).sort((a, b) => b.v - a.v);

  const unitField = (side) => ids.map((id) => {
    const rank = side === 'offense' ? ranks.offense.points[id] : ranks.defense.points[id];
    const ypp = side === 'offense' ? ranks.offense.ypp[id] : ranks.defense.ypp[id];
    // Judged on the unit, not the club: a coordinator does not pick the other
    // half of the roster, and the vote should not punish him for it.
    return { id, rank, v: (33 - rank) * 1.4 + (33 - ypp) * 0.9 };
  }).sort((a, b) => b.v - a.v);

  const oc = unitField('offense')[0];
  const dc = unitField('defense')[0];
  const coach = coachField[0];

  // CPU clubs have coordinators too; name them so an award reads like an award.
  const staffName = (teamId, role) => {
    const rng = mulberry32(hashSeed(`${season.seed}:staff:${teamId}:${role}`));
    return `${FIRST[Math.floor(rng() * FIRST.length)]} ${LAST[Math.floor(rng() * LAST.length)]}`;
  };

  const staff = [
    { key: 'coy', label: 'Coach of the Year', teamId: coach.id,
      name: season.carousel?.coaches?.[coach.id]?.name || `${TEAM_BY_ID[coach.id].city} head coach`,
      note: `${standings.byId[coach.id].w}\u2013${standings.byId[coach.id].l}, `
        + `${(standings.byId[coach.id].w - expected(coach.id)).toFixed(1)} wins above expectation` },
    { key: 'ocoy', label: 'Offensive Coordinator of the Year', teamId: oc.id,
      mine: oc.id === us ? 'OC' : null,
      name: oc.id === us ? null : staffName(oc.id, 'oc'),
      note: `${ordinal(oc.rank)} in scoring offense` },
    { key: 'dcoy', label: 'Defensive Coordinator of the Year', teamId: dc.id,
      mine: dc.id === us ? 'DC' : null,
      name: dc.id === us ? null : staffName(dc.id, 'dc'),
      note: `${ordinal(dc.rank)} in scoring defense` },
  ];

  return { awards, staff, year: season.year };
}

function ordinal(n) {
  const s = ['th', 'st', 'nd', 'rd'], v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

/** Which of these belong on a coordinator's résumé. */
export function staffHonours(result, seat, userTeam) {
  if (!result) return [];
  const key = seat === 'OC' ? 'ocoy' : 'dcoy';
  return result.staff
    .filter((a) => a.teamId === userTeam && (a.key === key || a.key === 'coy'))
    .map((a) => ({ key: a.key, label: a.label, year: result.year }));
}
