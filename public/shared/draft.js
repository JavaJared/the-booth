// draft.js — where next year's roster comes from.
//
// The mechanic that matters here is uncertainty. A prospect's true rating is
// hidden; you see a range, and scouting narrows it. Spend your week on the
// wrong players and you will draft confidently into a mistake — which is the
// honest version of what scouting is.
import { mulberry32, hashSeed } from './engine.js';
import { FIRST, LAST, RESERVED } from './names.js';
import { OFF_SPOTS, DEF_SPOTS } from './roster.js';
import { TEAMS, sortedStandings } from './league.js';

export const CLASS_SIZE = 104;
export const FA_SIZE = 20;
export const ROUNDS = 3;
export const SCOUT_POINTS = 12;
export const INFLUENCE = 6;

function gauss(rng, mean, sd) {
  let u = 0, v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return mean + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

const POSITIONS = [
  ...OFF_SPOTS.map((s) => ({ pos: s.label, side: 'offense', spot: s.id, base: s.base })),
  ...DEF_SPOTS.map((s) => ({ pos: s.label, side: 'defense', spot: s.id, base: s.base })),
];

function drawName(rng, used) {
  for (let i = 0; i < 60; i++) {
    const n = `${FIRST[Math.floor(rng() * FIRST.length)]} ${LAST[Math.floor(rng() * LAST.length)]}`;
    if (!used.has(n) && !RESERVED.has(n.toLowerCase())) { used.add(n); return n; }
  }
  return `Prospect ${used.size + 1}`;
}

/* ---------------------------------------------------------------- classes */

/**
 * A draft class. `rating` is the truth and is never shown; `floor` and `ceiling`
 * are what your area scouts have so far, and they start wide.
 */
export function makeClass(seed, year, used = new Set()) {
  const rng = mulberry32(hashSeed(`${seed}:draft:${year}`));
  const out = [];
  for (let i = 0; i < CLASS_SIZE; i++) {
    const slot = POSITIONS[Math.floor(rng() * POSITIONS.length)];
    // Most of a class is depth; a handful are genuinely good.
    const tier = rng();
    const rating = Math.round(clamp(
      gauss(rng, tier > 0.92 ? 84 : tier > 0.70 ? 76 : 69, 6), 52, 97));
    // How hard he is to read. Small-school and raw players have wide bands.
    const noise = clamp(gauss(rng, 7.5, 2.8), 3, 14);
    out.push({
      id: `p${year}-${i}`,
      name: drawName(rng, used),
      pos: slot.pos, side: slot.side, spot: slot.spot,
      age: 21 + Math.floor(rng() * 3),
      rating,                       // hidden truth
      noise,                        // scouting difficulty
      scouted: 0,
      buzz: Math.round(clamp(rating + gauss(rng, 0, noise), 45, 99)), // the public read
    });
  }
  return out.sort((a, b) => b.buzz - a.buzz);
}

/** Veterans on the market. Their tape is public, so ratings are known — the
 *  risk is age, not evaluation. */
export function makeFreeAgents(seed, year, used = new Set()) {
  const rng = mulberry32(hashSeed(`${seed}:fa:${year}`));
  const out = [];
  for (let i = 0; i < FA_SIZE; i++) {
    const slot = POSITIONS[Math.floor(rng() * POSITIONS.length)];
    const age = 26 + Math.floor(rng() * 8);
    const rating = Math.round(clamp(gauss(rng, 76, 7), 58, 94));
    // Older players cost less and fall off faster.
    const decline = age >= 31 ? 3 + Math.round(rng() * 4) : age >= 29 ? 1 + Math.round(rng() * 2) : 0;
    out.push({
      id: `fa${year}-${i}`, name: drawName(rng, used),
      pos: slot.pos, side: slot.side, spot: slot.spot,
      age, rating, decline,
      price: Math.round(clamp((rating - 55) * 1.6 - decline * 2, 4, 60)),
    });
  }
  return out.sort((a, b) => b.rating - a.rating);
}

/* --------------------------------------------------------------- scouting */

/** What a coordinator can see about a prospect right now. */
export function scoutView(p) {
  const looks = p.scouted || 0;
  // The estimate walks toward the truth with every look rather than snapping to
  // it at the end — one look has to be worth something, and three should not
  // make you omniscient.
  const pull = 1 - Math.pow(0.42, looks);
  const centre = p.buzz + (p.rating - p.buzz) * pull * 0.94;
  const band = Math.max(2, p.noise * Math.pow(0.58, looks));
  return {
    floor: Math.round(clamp(centre - band, 40, 99)),
    ceiling: Math.round(clamp(centre + band, 40, 99)),
    band: Math.round(band),
    confidence: looks >= 3 ? 'high' : looks >= 1 ? 'some' : 'none',
  };
}

/** Spend a scouting point. Coordinators only scout their own side of the ball. */
export function scout(prospects, id, seat) {
  return prospects.map((p) => {
    if (p.id !== id) return p;
    const mine = seat === 'OC' ? 'offense' : 'defense';
    if (p.side !== mine) return p;
    return { ...p, scouted: Math.min(3, (p.scouted || 0) + 1) };
  });
}

/* ------------------------------------------------------------- draft order */

export function draftOrder(season) {
  const reg = season.results.filter((r) => !r.playoff);
  const rows = sortedStandings(reg).all;
  // Worst record picks first; ties broken by points scored, fewest first.
  const order = [...rows].sort((a, b) => a.pct - b.pct || a.pf - b.pf).map((r) => r.id);
  const picks = [];
  for (let round = 1; round <= ROUNDS; round++) {
    order.forEach((team, i) => picks.push({ round, overall: (round - 1) * 32 + i + 1, team }));
  }
  return picks;
}

/* ------------------------------------------------------------ roster moves */

const spotsFor = (side) => (side === 'offense' ? OFF_SPOTS : DEF_SPOTS);

/**
 * Slot a new player onto a roster. He takes the weakest spot his position can
 * play, and only if he is actually an upgrade — otherwise he is depth and the
 * roster is unchanged.
 */
export function addToRoster(roster, player) {
  const side = player.side;
  const list = [...roster[side]];
  const candidates = list
    .map((cur, i) => ({ cur, i }))
    .filter(({ cur }) => cur.pos === player.pos)
    .sort((a, b) => a.cur.rating - b.cur.rating);
  if (!candidates.length) return { roster, replaced: null, kept: false };
  const worst = candidates[0];
  if (player.rating <= worst.cur.rating) return { roster, replaced: null, kept: false };
  list[worst.i] = {
    ...worst.cur, name: player.name, rating: player.rating,
    age: player.age, acquired: player.id,
  };
  // Re-rank the position group so the best player holds the starting spot.
  // Slotting a signing into the weakest slot left better players as backups.
  const group = list.map((cur, i) => ({ cur, i })).filter(({ cur }) => cur.pos === player.pos);
  const ranked = [...group].sort((a, b) => b.cur.rating - a.cur.rating);
  const slots = group.map(({ cur }) => ({ spot: cur.spot, number: cur.number }))
    .sort((a, b) => spotsFor(side).findIndex((s) => s.id === a.spot)
                  - spotsFor(side).findIndex((s) => s.id === b.spot));
  ranked.forEach((entry, k) => {
    list[entry.i] = { ...entry.cur, spot: slots[k].spot, number: slots[k].number };
  });
  list.sort((a, b) => spotsFor(side).findIndex((s) => s.id === a.spot)
                    - spotsFor(side).findIndex((s) => s.id === b.spot));
  return { roster: { ...roster, [side]: list }, replaced: worst.cur, kept: true };
}

/** What a CPU club wants: the biggest hole it can fill. */
export function teamNeed(roster, side) {
  const list = roster[side];
  const byGap = list
    .map((p) => ({ spot: p.spot, pos: p.pos, gap: (spotsFor(side).find((s) => s.id === p.spot)?.base || 75) - p.rating }))
    .sort((a, b) => b.gap - a.gap);
  return byGap[0];
}

/**
 * What the general manager thinks of a prospect. His scouting is his own — he
 * is not reading your reports, and he is wrong in his own direction. This is
 * why a player you have fully scouted can still slide past your club.
 */
export function gmView(p, seed) {
  const rng = mulberry32(hashSeed(`${seed}:gm:${p.id}`));
  return p.rating + gauss(rng, 0, p.noise * 0.8);
}

/**
 * Your club's pick. The coordinators do not make it — the general manager
 * does. All you can do is lean on him: push your side of the ball, or pound
 * the table for one player. He listens, up to a point.
 */
export function gmPick(available, roster, seed, rng, lobby = {}) {
  const push = lobby.side || 0;            // positive favours offense
  const table = new Set(lobby.table || []);
  const needOff = teamNeed(roster, 'offense');
  const needDef = teamNeed(roster, 'defense');

  const scored = available.map((p) => {
    let v = gmView(p, seed);
    const need = p.side === 'offense' ? needOff : needDef;
    if (p.pos === need.pos && need.gap > 0) v += Math.min(9, need.gap * 0.8);
    // Lobbying moves the room, but it does not run it. Six points of push
    // tilts the side of the ball heavily without settling it.
    v += (p.side === 'offense' ? push : -push) * 0.75;
    // Pounding the table is a strong preference for a specific player — but
    // only if he is still there when the club is on the clock.
    if (table.has(p.id)) v += 13;
    return { p, v: v + gauss(rng, 0, 3.0) };
  }).sort((a, b) => b.v - a.v);
  return scored[0]?.p || available[0];
}

/**
 * A CPU pick: mostly the best player available by public buzz, weighted toward
 * a position of need. Clubs cannot see true ratings either.
 */
export function cpuPick(available, roster, rng) {
  const needOff = teamNeed(roster, 'offense');
  const needDef = teamNeed(roster, 'defense');
  const scored = available.map((p) => {
    let v = p.buzz;
    if (p.pos === needOff.pos && needOff.gap > 0) v += Math.min(9, needOff.gap * 0.8);
    if (p.pos === needDef.pos && needDef.gap > 0) v += Math.min(9, needDef.gap * 0.8);
    return { p, v: v + gauss(rng, 0, 3.5) };
  }).sort((a, b) => b.v - a.v);
  return scored[0]?.p || available[0];
}

/* ------------------------------------------------------------ progression */

/** Between seasons players age: the young improve, the old fall away. */
export function ageRoster(roster, seed, year) {
  const rng = mulberry32(hashSeed(`${seed}:age:${year}`));
  const step = (list) => list.map((p) => {
    const age = (p.age || 26) + 1;
    let delta;
    // Tuned to drift slightly negative across the league. The draft is what
    // replenishes talent; without a net decline every roster ratchets upward
    // year on year and the whole rating scale inflates.
    if (age <= 24) delta = gauss(rng, 2.0, 2.0);
    else if (age <= 27) delta = gauss(rng, 0.5, 1.8);
    else if (age <= 30) delta = gauss(rng, -0.9, 1.8);
    else delta = gauss(rng, -3.1, 2.2);
    return { ...p, age, rating: Math.round(clamp(p.rating + delta, 45, 99)) };
  });
  return { offense: step(roster.offense), defense: step(roster.defense) };
}
