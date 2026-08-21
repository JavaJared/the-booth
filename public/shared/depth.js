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
  const list = orderByTalent(roster[side], side);
  const us = season.userTeam;

  // Add up every week that has actually been played.
  const totals = {};
  for (const r of season.results) {
    if (!r.final || !r.players) continue;
    if (r.home !== us && r.away !== us) continue;
    for (const line of r.players[side] || []) {
      if (!line.name) continue;
      // A depth-chart reorder can move the same player from DT3 to DT or CB4
      // to CB2. Names are unique within the generated league and remain stable,
      // while the slot is an assignment, so season stats follow the player.
      const k = line.name;
      if (!totals[k]) totals[k] = { ...blank(), games: 0 };
      const t = totals[k];
      t.games++;
      for (const [key, v] of Object.entries(line)) {
        if (typeof v !== 'number') continue;
        if (key === 'rushLong' || key === 'recLong') t[key] = Math.max(t[key] || 0, v);
        else t[key] = (t[key] || 0) + v;
      }
    }
  }

  return list.map((p) => {
    const t = totals[p.name] || { ...blank(), games: 0 };
    return {
      spot: p.spot, pos: p.pos, name: p.name, number: p.number,
      rating: p.rating,
      traits: p.traits || null,
      development: p.development || 'normal',
      age: p.age ?? null,
      rookie: p.draftedIn != null && p.draftedIn >= (season.year - 1),
      ...t,
      sacks: halves(t.sacks),
      tackles: Math.round(t.tackles),
    };
  });
}

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

/* ------------------------------------------------- per-game player lines */

const blank = () => ({
  att: 0, comp: 0, passYards: 0, passTD: 0, int: 0, sacked: 0,
  carries: 0, rushYards: 0, rushTD: 0, rushLong: 0,
  targets: 0, rec: 0, recYards: 0, recTD: 0, recLong: 0,
  tackles: 0, sacks: 0, pbu: 0, ints: 0, ffum: 0,
});

/** Tackles and sacks come in halves and nothing finer. */
export const halves = (x) => Math.round(x * 2) / 2;

const bump = (map, who) => {
  if (!who?.name) return null;
  const k = `${who.spot}|${who.name}`;
  if (!map[k]) map[k] = { spot: who.spot, pos: who.pos, name: who.name, ...blank() };
  return map[k];
};

/**
 * A real box score, read off the snaps that were actually played. Used for any
 * game a coordinator called himself — nothing is estimated here.
 */
export function playerLinesFromPlays(plays) {
  const off = {}, def = {};
  for (const p of plays) {
    const o = p.outcome;
    const c = o?.cast;
    if (!c) continue;
    if (o.penalty && o.penalty.replay) continue;   // the flag wiped the play out
    const y = o.yards || 0;
    const scored = (p.events || []).some((e) => e.type === 'score' && /Touchdown/.test(e.text));
    // Our possession means our offence is on the field and the men making
    // tackles belong to the opponent — so a snap only credits ONE of our
    // units. Mapping both sides on every snap put the opponent's quarterback
    // in our defensive column.
    const ours = p.possession === 'US';
    const oMap = ours ? off : null;      // our offence, only when we have it
    const dMap = ours ? null : def;      // our defence, only when they do

    if (!oMap && !dMap) continue;

    if (oMap && c.carrier) {
      const r = bump(oMap, c.carrier);
      if (r) {
        r.carries++; r.rushYards += y; r.rushLong = Math.max(r.rushLong, y);
        if (scored) r.rushTD++;
      }
    } else if (oMap && c.passer) {
      const q = bump(oMap, c.passer);
      if (q) {
        if (o.sack) { q.sacked++; q.passYards += y; }
        else {
          q.att++;
          if (o.turnover === 'interception') q.int++;
          if (o.complete) { q.comp++; q.passYards += y; if (scored) q.passTD++; }
        }
      }
      if (c.target && !o.sack) {
        const t = bump(oMap, c.target);
        if (t) {
          t.targets++;
          if (o.complete) {
            t.rec++; t.recYards += y; t.recLong = Math.max(t.recLong, y);
            if (scored) t.recTD++;
          }
        }
      }
    }
    // Our defence is credited only on snaps the opponent ran.
    if (dMap) {
      if (c.sacker) { const r = bump(dMap, c.sacker); if (r) { r.sacks += 1; r.tackles += 1; } }
      if (c.interceptor) { const r = bump(dMap, c.interceptor); if (r) r.ints += 1; }
      if (c.breakup) { const r = bump(dMap, c.breakup); if (r) r.pbu += 1; }
      if (c.tackler) { const r = bump(dMap, c.tackler); if (r) r.tackles += 1; }
      if (c.forced) { const r = bump(dMap, c.forced); if (r) r.ffum += 1; }
    }
  }
  return { offense: Object.values(off), defense: Object.values(def) };
}

function gaussFrom(rng, mean, sd) {
  let u = 0, v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return mean + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/**
 * One week's lines for a game the staff simulated. No snaps were logged, so
 * the week's unit totals are attributed across the depth chart — but it is
 * done once, when the game is played, and then stored. That is what makes the
 * season add up instead of shifting under you every render.
 */
export function simPlayerLines(roster, ourUnit, theirUnit, seedKey) {
  const rng = mulberry32(hashSeed(seedKey));
  const offList = orderByTalent(roster.offense, 'offense');
  const defList = orderByTalent(roster.defense, 'defense');

  const norm = (list, share, key) => {
    const total = list.reduce((a, p) => a + ((share[p.spot] || {})[key] || 0), 0);
    return (p) => (total ? ((share[p.spot] || {})[key] || 0) / total : 0);
  };
  const skew = (list) => {
    const byPos = {};
    for (const p of list) (byPos[p.pos] = byPos[p.pos] || []).push(p.rating);
    return (p) => {
      const g = byPos[p.pos];
      const mean = g.reduce((a, b) => a + b, 0) / g.length;
      return clamp(1 + (p.rating - mean) / 90, 0.7, 1.35);
    };
  };
  // A weekly wobble, so a back does not carry exactly the same number of times
  // every single week.
  const wob = () => clamp(gaussFrom(rng, 1, 0.26), 0.4, 1.7);

  // A unit's plays include sacks, penalties and kneels. Dropbacks and carries
  // together are well under the total, and 0.58 + 0.40 was handing out nearly
  // every snap twice — which is how a quarterback reached 735 attempts.
  const passAtt = Math.round(ourUnit.plays * 0.53);
  const carries = Math.round(ourUnit.plays * 0.38);
  const tds = Math.max(0, Math.round(ourUnit.points / 7.4));

  const oSkew = skew(offList);
  const nPass = norm(offList, OFF_SHARE, 'passAtt');
  const nRush = norm(offList, OFF_SHARE, 'rush');
  const nTgt = norm(offList, OFF_SHARE, 'targets');

  const offense = offList.map((p) => {
    const k = oSkew(p);
    const row = { spot: p.spot, pos: p.pos, name: p.name, ...blank() };
    const pa = nPass(p), ru = nRush(p), tg = nTgt(p);
    if (pa > 0) {
      row.att = Math.round(passAtt * pa * wob());
      row.comp = Math.round(row.att * clamp(0.58 + (p.rating - 75) / 320, 0.42, 0.76));
      // One game's passing, so the season total cannot run away.
      row.passYards = Math.round(clamp(ourUnit.passYards * pa * k * wob(), 0, 470));
      row.passTD = Math.round(tds * 0.62 * pa * wob());
      row.int = Math.max(0, Math.round(row.att * (0.030 - (p.rating - 75) / 2600) * wob()));
    }
    if (ru > 0) {
      row.carries = Math.round(carries * ru * k * wob());
      row.rushYards = Math.round(ourUnit.rushYards * ru * k * wob());
      row.rushTD = Math.round(tds * ru * 0.55 * wob());
      row.rushLong = row.carries
        ? Math.max(1, Math.round((row.rushYards / Math.max(1, row.carries))
            * clamp(gaussFrom(rng, 3.1, 1.2), 1.2, 7))) : 0;
    }
    if (tg > 0) {
      row.targets = Math.round(passAtt * tg * k * wob());
      row.rec = Math.round(row.targets * clamp(0.60 + (p.rating - 75) / 300, 0.40, 0.80));
      row.recYards = Math.round(ourUnit.passYards * tg * k * wob());
      row.recTD = Math.round(tds * tg * 0.9 * wob());
      row.recLong = row.rec
        ? Math.max(1, Math.round((row.recYards / Math.max(1, row.rec))
            * clamp(gaussFrom(rng, 2.4, 0.9), 1.1, 5))) : 0;
    }
    return row;
  });

  const dSkew = skew(defList);
  const nTkl = norm(defList, DEF_SHARE, 'tackles');
  const nSk = norm(defList, DEF_SHARE, 'sacks');
  const nPbu = norm(defList, DEF_SHARE, 'pbu');
  const nInt = norm(defList, DEF_SHARE, 'ints');
  const tackles = Math.round(theirUnit.plays * 0.70);
  const sacks = clamp(gaussFrom(rng, 2.6, 1.4), 0, 9);
  const pbu = Math.round(clamp(gaussFrom(rng, 4.2, 1.8), 0, 12));

  const defense = defList.map((p) => {
    const k = dSkew(p);
    return {
      spot: p.spot, pos: p.pos, name: p.name, ...blank(),
      tackles: Math.round(tackles * nTkl(p) * k * wob()),
      sacks: halves(sacks * nSk(p) * k * wob()),
      pbu: Math.round(pbu * nPbu(p) * k * wob()),
      ints: rng() < theirUnit.turnovers * nInt(p) * 0.55 ? 1 : 0,
      ffum: rng() < nTkl(p) * 0.30 ? 1 : 0,
    };
  });

  return { offense, defense };
}
