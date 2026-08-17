// depth.js — who you actually have, and what they did with it.
//
// The season stores team-level stat lines rather than every play of every
// week, so player numbers are attributed from those totals using each man's
// share of the work at his position. A game you called yourself contributes
// its real box score; a game your staff handled is attributed. Either way the
// point is the same: see where the roster is thin before you spend a draft on
// the wrong side of the ball.
import { OFF_SPOTS, DEF_SPOTS, bySpot } from './roster.js';
import { OFF_BY_ID } from './playbook.js';
import { mulberry32, hashSeed } from './engine.js';

/** How the ball is shared at each spot, as a rough fraction of unit volume. */
const OFF_SHARE = {
  QB:  { passAtt: 0.94, rush: 0.05 }, QB2: { passAtt: 0.06, rush: 0.01 },
  RB1: { rush: 0.54, targets: 0.12 }, RB2: { rush: 0.26, targets: 0.06 },
  RB3: { rush: 0.09, targets: 0.02 }, FB: { rush: 0.03, targets: 0.01 },
  WR1: { targets: 0.25 }, WR2: { targets: 0.18 }, WR3: { targets: 0.12 },
  WR4: { targets: 0.05 }, WR5: { targets: 0.02 },
  TE1: { targets: 0.15 }, TE2: { targets: 0.05 }, TE3: { targets: 0.01 },
};
const DEF_SHARE = {
  EDGE1: { tackles: 0.09, sacks: 0.26, pbu: 0.02 },
  EDGE2: { tackles: 0.07, sacks: 0.18, pbu: 0.02 },
  EDGE3: { tackles: 0.02, sacks: 0.05 }, EDGE4: { tackles: 0.01, sacks: 0.02 },
  DT:    { tackles: 0.08, sacks: 0.14, pbu: 0.01 },
  DT2:   { tackles: 0.05, sacks: 0.07 }, DT3: { tackles: 0.02, sacks: 0.03 },
  LB1:   { tackles: 0.19, sacks: 0.09, pbu: 0.07, ints: 0.10 },
  LB2:   { tackles: 0.13, sacks: 0.06, pbu: 0.05, ints: 0.06 },
  LB3:   { tackles: 0.05, sacks: 0.02, pbu: 0.02, ints: 0.02 },
  CB1:   { tackles: 0.10, sacks: 0.01, pbu: 0.24, ints: 0.24 },
  CB2:   { tackles: 0.09, sacks: 0.01, pbu: 0.19, ints: 0.18 },
  CB3:   { tackles: 0.03, pbu: 0.06, ints: 0.05 },
  NB:    { tackles: 0.07, sacks: 0.04, pbu: 0.11, ints: 0.10 },
  NB2:   { tackles: 0.02, pbu: 0.03, ints: 0.02 },
  S1:    { tackles: 0.10, sacks: 0.02, pbu: 0.09, ints: 0.16 },
  S2:    { tackles: 0.08, sacks: 0.01, pbu: 0.06, ints: 0.10 },
  S3:    { tackles: 0.02, pbu: 0.02, ints: 0.02 },
};

const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

/** Put the best man at each position in the first slot for that position. */
function orderByTalent(list, side) {
  const spots = side === 'offense' ? OFF_SPOTS : DEF_SPOTS;
  const out = [...list];
  const byPos = {};
  out.forEach((p, i) => { (byPos[p.pos] = byPos[p.pos] || []).push(i); });
  for (const idxs of Object.values(byPos)) {
    const ranked = idxs.map((i) => out[i]).sort((a, b) => b.rating - a.rating);
    const slots = idxs.map((i) => out[i].spot)
      .sort((a, b) => spots.findIndex((s) => s.id === a) - spots.findIndex((s) => s.id === b));
    idxs.forEach((i, k) => {
      const target = slots.indexOf(out[i].spot);
      // Spread the whole player, then override the slot; picking fields by
      // hand is how age went missing in the first place.
      out[i] = { ...ranked[target], spot: slots[target] };
    });
  }
  return out.sort((a, b) => spots.findIndex((s) => s.id === a.spot)
                          - spots.findIndex((s) => s.id === b.spot));
}

/** Every game this club played, from its own point of view. */
function ourGames(season) {
  const us = season.userTeam;
  return season.results
    .filter((r) => r.final && (r.home === us || r.away === us))
    .map((r) => {
      const home = r.home === us;
      return {
        week: r.week, played: !!r.played,
        off: home ? r.homeStats : r.awayStats,
        def: home ? r.awayStats : r.homeStats,
      };
    })
    .filter((g) => g.off && g.def);
}

/**
 * Season totals per player. Talent skews the share a little — a much better
 * receiver than the man beside him sees more of the ball — but the shape comes
 * from the depth chart, which is what makes a thin spot visible.
 */
export function depthChart(season, side) {
  const roster = season.rosters[season.userTeam];
  if (!roster) return [];
  // Rank each position group by rating before assigning shares. A backup who
  // outgrades the starter would otherwise be handed the starter's volume,
  // which made a 52-rated back the leading rusher.
  const list = orderByTalent(roster[side], side);
  const spots = side === 'offense' ? OFF_SPOTS : DEF_SPOTS;
  const share = side === 'offense' ? OFF_SHARE : DEF_SHARE;
  const games = ourGames(season);
  const rng = mulberry32(hashSeed(`${season.seed}:stats:${season.year}:${side}`));

  // Unit totals for the year.
  const tot = games.reduce((a, g) => {
    const u = side === 'offense' ? g.off : g.def;
    a.plays += u.plays; a.yards += u.yards; a.pass += u.passYards;
    a.rush += u.rushYards; a.points += u.points; a.to += u.turnovers;
    return a;
  }, { plays: 0, yards: 0, pass: 0, rush: 0, points: 0, to: 0 });

  // Rough volume for the year, scaled from games actually played.
  const n = Math.max(1, games.length);
  const passAtt = Math.round(tot.plays * 0.58);
  const carries = Math.round(tot.plays * 0.40);
  const tackles = Math.round(tot.plays * 0.82);
  const sacks = Math.round(clamp(n * 2.3 - tot.points / 60, 12, 62));
  const pbu = Math.round(n * 4.2);
  const ints = Math.round(clamp(tot.to * 0.62, 0, 34));
  const tds = Math.round(tot.points / 7.4);

  // The share table describes a full depth chart, but a roster can carry more
  // or fewer at a spot. Normalise each category so the pieces still add up to
  // the unit's actual production rather than inflating past it.
  const totals = {};
  for (const p of list) {
    const sh = share[p.spot] || {};
    for (const [k, v] of Object.entries(sh)) totals[k] = (totals[k] || 0) + v;
  }
  const norm = (key, v) => (totals[key] ? v / totals[key] : 0);

  // Talent weighting inside a position group.
  const groupAvg = {};
  for (const p of list) {
    (groupAvg[p.pos] = groupAvg[p.pos] || []).push(p.rating);
  }
  const skew = (p) => {
    const g = groupAvg[p.pos];
    const mean = g.reduce((a, b) => a + b, 0) / g.length;
    return clamp(1 + (p.rating - mean) / 90, 0.7, 1.35);
  };

  return list.map((p) => {
    const s = share[p.spot] || {};
    const k = skew(p);
    const row = {
      spot: p.spot, pos: p.pos, name: p.name, number: p.number,
      rating: p.rating,
      age: p.age ?? null,
      // A rookie for exactly one season after he was taken.
      rookie: p.draftedIn != null && p.draftedIn >= (season.year - 1),
      starter: spots.findIndex((x) => x.id === p.spot) ===
        spots.findIndex((x) => x.id === list.find((q) => q.pos === p.pos)?.spot),
      games: games.length,
    };
    if (side === 'offense') {
      if (s.passAtt) {
        row.att = Math.round(passAtt * norm('passAtt', s.passAtt));
        row.comp = Math.round(row.att * clamp(0.58 + (p.rating - 75) / 320, 0.45, 0.74));
        row.passYards = Math.round(tot.pass * 0.94 * norm('passAtt', s.passAtt) * k);
        row.passTD = Math.round(tds * 0.62 * norm('passAtt', s.passAtt) * k);
        row.int = Math.round(clamp(row.att * (0.030 - (p.rating - 75) / 2600), 0, 30));
      }
      if (s.rush) {
        row.carries = Math.round(carries * norm('rush', s.rush) * k);
        row.rushYards = Math.round(tot.rush * norm('rush', s.rush) * k * 1.12);
        row.rushTD = Math.round(tds * norm('rush', s.rush) * 0.55 * k);
      }
      if (s.targets) {
        row.targets = Math.round(passAtt * norm('targets', s.targets) * k);
        row.rec = Math.round(row.targets * clamp(0.60 + (p.rating - 75) / 300, 0.42, 0.78));
        // Out of the same pool the quarterback threw for, so the two agree.
        row.recYards = Math.round(tot.pass * 0.94 * norm('targets', s.targets) * k);
        row.recTD = Math.round(tds * norm('targets', s.targets) * 0.9 * k);
      }
    } else {
      row.tackles = Math.round(tackles * norm('tackles', s.tackles || 0) * k);
      row.sacks = +(sacks * norm('sacks', s.sacks || 0) * k).toFixed(1);
      row.pbu = Math.round(pbu * norm('pbu', s.pbu || 0) * k);
      row.ints = Math.round(ints * norm('ints', s.ints || 0) * k);
    }
    return row;
  });
}

/**
 * Where the roster is weak, measured against what the position is normally
 * worth. This is the list you should be drafting from.
 */
/**
 * Weakness by position group rather than by player. A thin fourth receiver is
 * not a draft need; a receiver room whose best two are mediocre is. Judged on
 * the spots the play engine actually resolves with, since those are what your
 * unit is graded on.
 */
export function rosterNeeds(season, side) {
  const roster = season.rosters[season.userTeam];
  const spots = side === 'offense' ? OFF_SPOTS : DEF_SPOTS;
  const keyIds = new Set(spots.filter((s) => s.key).map((s) => s.id));

  // Specialists cannot be scouted or drafted, so listing them as a need would
  // point you at something you cannot act on.
  const SPECIALIST = new Set(['K', 'P', 'LS']);
  const groups = {};
  for (const p of roster[side]) {
    if (SPECIALIST.has(p.pos)) continue;
    const g = (groups[p.pos] = groups[p.pos] || { pos: p.pos, players: [] });
    g.players.push(p);
  }

  return Object.values(groups).map((g) => {
    const ranked = [...g.players].sort((a, b) => b.rating - a.rating);
    const starters = g.players.filter((p) => keyIds.has(p.spot)).length || 1;
    const top = ranked.slice(0, starters);
    const have = top.reduce((a, p) => a + p.rating, 0) / top.length;
    const par = top.reduce((a, p) =>
      a + (spots.find((s) => s.id === p.spot)?.base || 75), 0) / top.length;
    const oldest = Math.max(...ranked.slice(0, starters).map((p) => p.age || 26));
    return {
      pos: g.pos,
      starters,
      best: ranked[0],
      name: ranked[0].name,
      rating: Math.round(have),
      age: oldest,
      depth: g.players.length,
      gap: +(par - have).toFixed(1),
    };
  }).sort((a, b) => b.gap - a.gap);
}

/** A one-line read on the state of a unit. */
export function unitSummary(season, side) {
  const rows = rosterNeeds(season, side);
  const holes = rows.filter((r) => r.gap >= 4);
  const aging = season.rosters[season.userTeam][side].filter((p) => (p.age || 26) >= 31);
  const young = season.rosters[season.userTeam][side].filter((p) => (p.age || 26) <= 23);
  // The average that matters is the one the play engine reads: starters.
  const spots = side === 'offense' ? OFF_SPOTS : DEF_SPOTS;
  const keyIds = new Set(spots.filter((s) => s.key).map((s) => s.id));
  const starters = season.rosters[season.userTeam][side].filter((p) => keyIds.has(p.spot));
  const avg = starters.reduce((a, p) => a + p.rating, 0) / Math.max(1, starters.length);
  return {
    average: +avg.toFixed(1),
    holes: holes.slice(0, 3),
    agingCount: aging.length,
    youngCount: young.length,
  };
}
