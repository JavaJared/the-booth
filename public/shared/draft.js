// draft.js — the draft as its own event.
//
// Three ideas hold this together:
//   1. A prospect is a set of traits, not a number. What matters depends on
//      the position: a corner's speed is not a guard's speed.
//   2. Everything you know is earned. Traits arrive as letter grade ranges
//      that narrow with scouting; the combine gives you a few for free, but
//      only for the players who chose to attend.
//   3. You never pick. The general manager does, off his own board. You spend
//      a finite pool of advocacy across seven rounds trying to move him.
import { mulberry32, hashSeed } from './engine.js';
import { FIRST, LAST, RESERVED } from './names.js';
import { OFF_SPOTS, DEF_SPOTS } from './roster.js';
import { TEAMS, sortedStandings } from './league.js';
import {
  TRAITS, POSITION_TRAITS, grade, ratingFromTraits, traitsFromRating, developmentFromRng,
} from './ratings.js';

export { TRAITS, POSITION_TRAITS } from './ratings.js';

export const CLASS_SIZE = 224;
export const FA_SIZE = 24;
export const ROUNDS = 7;
export const SCOUT_POINTS = 30;
export const SCOUT_MAX_PER_PLAYER = 4;
export const ADVOCACY = 20;
export const BOARD_MAX = 12;

function gauss(rng, mean, sd) {
  let u = 0, v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return mean + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

export const POSITION_GROUPS = {
  offense: [
    { key: 'QB', label: 'Quarterbacks', pos: ['QB'] },
    { key: 'RB', label: 'Running backs', pos: ['RB'] },
    { key: 'WR', label: 'Receivers', pos: ['WR'] },
    { key: 'TE', label: 'Tight ends', pos: ['TE'] },
    { key: 'OL', label: 'Offensive line', pos: ['OL'] },
  ],
  defense: [
    { key: 'EDGE', label: 'Edge rushers', pos: ['EDGE'] },
    { key: 'DT', label: 'Interior line', pos: ['DT'] },
    { key: 'LB', label: 'Linebackers', pos: ['LB'] },
    { key: 'CB', label: 'Cornerbacks', pos: ['CB', 'NB'] },
    { key: 'S', label: 'Safeties', pos: ['S'] },
  ],
};

export { grade } from './ratings.js';
const GRADE_ORDER = ['F', 'D', 'D+', 'C-', 'C', 'C+', 'B-', 'B', 'B+', 'A-', 'A', 'A+'];
export const gradeRank = (g) => GRADE_ORDER.indexOf(g);

/* -------------------------------------------------------------- prospects */

// Only positions with a trait profile can be scouted, which also keeps
// kickers, punters and long snappers out of a seven round draft.
const POSITIONS = [
  ...OFF_SPOTS.map((s) => ({ pos: s.label, side: 'offense', spot: s.id })),
  ...DEF_SPOTS.map((s) => ({ pos: s.label, side: 'defense', spot: s.id })),
].filter((p) => POSITION_TRAITS[p.pos]);
const UNIQUE_POS = [...new Map(POSITIONS.map((p) => [p.pos, p])).values()];

function drawName(rng, used) {
  for (let i = 0; i < 60; i++) {
    const n = `${FIRST[Math.floor(rng() * FIRST.length)]} ${LAST[Math.floor(rng() * LAST.length)]}`;
    if (!used.has(n) && !RESERVED.has(n.toLowerCase())) { used.add(n); return n; }
  }
  return `Prospect ${used.size + 1}`;
}

const SCHOOLS = ['Braxton State', 'Cape Hollow', 'Dunmore', 'Eastvale Tech', 'Fairhaven',
  'Granite Falls', 'Harlow', 'Ironwood A&M', 'Kestrel Bay', 'Lakemoor', 'Marrow Ridge',
  'Northgate', 'Oakhurst', 'Pinecrest', 'Quarry Hill', 'Redbank', 'Sable Creek',
  'Thornfield', 'Ulster Poly', 'Verdant Valley', 'Westmarch', 'Yarrow College'];

/**
 * Combine numbers, derived from the traits they actually measure. This is why
 * the combine is worth attending to: a 4.38 forty is hard evidence about speed
 * that no amount of tape-watching gives you for free.
 */
function combineFor(t, rng) {
  const inv = (v, best, worst) => +(best + (worst - best) * (1 - v / 99)).toFixed(2);
  return {
    forty: inv(t.speed, 4.28, 5.45),
    shuttle: inv(t.agility, 3.95, 4.85),
    vertical: Math.round(clamp(24 + (t.burst / 99) * 21 + gauss(rng, 0, 1.2), 22, 46)),
    bench: Math.round(clamp(8 + (t.power / 99) * 30 + gauss(rng, 0, 2.5), 6, 42)),
    broad: Math.round(clamp(96 + (t.burst / 99) * 44 + gauss(rng, 0, 3), 92, 145)),
  };
}
/** Which trait each combine drill is evidence for. */
export const DRILL_TRAIT = { forty: 'speed', shuttle: 'agility', vertical: 'burst',
  bench: 'power', broad: 'burst' };
export const DRILL_LABEL = { forty: '40 yard', shuttle: 'Shuttle', vertical: 'Vertical',
  bench: 'Bench', broad: 'Broad jump' };

export function makeClass(seed, year, used = new Set()) {
  const rng = mulberry32(hashSeed(`${seed}:draft:${year}`));
  const out = [];
  for (let i = 0; i < CLASS_SIZE; i++) {
    const slot = UNIQUE_POS[Math.floor(rng() * UNIQUE_POS.length)];
    const weights = POSITION_TRAITS[slot.pos];

    // A prospect's overall level, then traits scattered around it. Some are
    // lopsided: elite at one thing, poor at another, which is what makes the
    // position-specific weighting matter.
    const tier = rng();
    const level = clamp(gauss(rng, tier > 0.94 ? 84 : tier > 0.72 ? 75 : 67, 6.5), 45, 97);
    const spread = clamp(gauss(rng, 8, 3), 3, 16);

    const traits = {};
    for (const key of Object.keys(TRAITS)) {
      const relevant = weights[key] != null;
      traits[key] = Math.round(clamp(
        gauss(rng, relevant ? level : level - 4, relevant ? spread : spread * 1.3), 25, 99));
    }
    // The overall is exactly the weighted blend of what matters at his spot.
    const rating = ratingFromTraits(slot.pos, traits, level);

    const noise = clamp(gauss(rng, 8, 3), 3.5, 15);
    // Better prospects almost all attend; fringe players and the injured skip it.
    const attends = rng() < clamp(0.35 + (rating - 60) / 55, 0.15, 0.95);

    out.push({
      id: `p${year}-${i}`,
      name: drawName(rng, used),
      pos: slot.pos, side: slot.side, spot: slot.spot,
      school: SCHOOLS[Math.floor(rng() * SCHOOLS.length)],
      age: 21 + Math.floor(rng() * 3),
      traits, rating, noise,
      development: developmentFromRng(mulberry32(hashSeed(`${seed}:dev:${year}:${i}`))),
      scouted: 0,
      combine: attends ? combineFor(traits, rng) : null,
      buzz: Math.round(clamp(rating + gauss(rng, 0, noise), 40, 99)),
    });
  }
  // Rank the class by public buzz once, at creation. This is the consensus
  // board: it never moves, no matter what your scouts turn up. Sorting by your
  // own findings would leak the answer — a player who jumped up the list after
  // one look would be telling you he is good before you read the report.
  out.sort((a, b) => b.buzz - a.buzz);
  out.forEach((p, i) => {
    p.projected = i + 1;
    p.projRound = Math.min(ROUNDS + 1, Math.floor(i / 32) + 1);
  });
  return out;
}

export function makeFreeAgents(seed, year, used = new Set()) {
  const rng = mulberry32(hashSeed(`${seed}:fa:${year}`));
  const out = [];
  for (let i = 0; i < FA_SIZE; i++) {
    const slot = UNIQUE_POS[Math.floor(rng() * UNIQUE_POS.length)];
    const age = 26 + Math.floor(rng() * 8);
    const rating = Math.round(clamp(gauss(rng, 76, 7), 58, 94));
    const traitRng = mulberry32(hashSeed(`${seed}:fa-traits:${year}:${i}`));
    const decline = age >= 31 ? 3 + Math.round(rng() * 4) : age >= 29 ? 1 + Math.round(rng() * 2) : 0;
    out.push({
      id: `fa${year}-${i}`, name: drawName(rng, used),
      pos: slot.pos, side: slot.side, spot: slot.spot,
      age, rating, traits: traitsFromRating(slot.pos, rating, traitRng),
      development: developmentFromRng(mulberry32(hashSeed(`${seed}:fa-dev:${year}:${i}`))),
      decline,
      price: Math.round(clamp((rating - 55) * 1.6 - decline * 2, 4, 60)),
    });
  }
  return out.sort((a, b) => b.rating - a.rating);
}

/* --------------------------------------------------------------- scouting */

/**
 * The scouting report. Each point spent reveals more: first the headline
 * grade, then the traits that matter most at the position, then the rest.
 * The range never closes entirely — you are always betting on something.
 */
export function scoutReport(p, opts = {}) {
  const looks = p.scouted || 0;
  const weights = POSITION_TRAITS[p.pos] || {};
  const keys = Object.keys(weights).sort((a, b) => weights[b] - weights[a]);

  // How many traits are legible at this level of work.
  const shown = looks <= 0 ? 0 : looks === 1 ? 2 : looks === 2 ? 3 : keys.length;
  // At full scouting there is nothing left to learn: the report reads exactly,
  // not narrowly. Anything short of that stays a range.
  const complete = looks >= SCOUT_MAX_PER_PLAYER;
  const pull = complete ? 1 : 1 - Math.pow(0.45, looks);
  const band = complete ? 0 : Math.max(2.5, p.noise * Math.pow(0.55, looks));

  /** Never let an incomplete read collapse to a single grade: a narrow band
   *  that happens to sit inside one letter is luck, not certainty. */
  const spread = (lo, hi) => {
    if (complete || lo !== hi) return [lo, hi];
    const at = GRADE_ORDER.indexOf(lo);
    return [GRADE_ORDER[Math.max(0, at - 1)], GRADE_ORDER[Math.min(GRADE_ORDER.length - 1, at + 1)]];
  };

  const traits = keys.map((key, i) => {
    const truth = p.traits[key];
    // The combine hands you a trait even with no scouting at all.
    const measured = p.combine && Object.entries(DRILL_TRAIT).some(([d, t]) => t === key && p.combine[d] != null);
    const known = i < shown || (measured && looks >= 0);
    if (!known) return { key, label: TRAITS[key], weight: weights[key], unknown: true };
    const centre = complete ? truth
      : measured && i >= shown
        ? truth + gauss(mulberry32(hashSeed(`${p.id}:${key}`)), 0, 4)
        : p.buzz + (truth - p.buzz) * Math.max(pull, measured ? 0.85 : 0);
    const b = complete ? 0 : (measured && i >= shown ? 5 : band);
    const [low, high] = spread(grade(clamp(centre - b, 25, 99)), grade(clamp(centre + b, 25, 99)));
    return {
      key, label: TRAITS[key], weight: weights[key], low, high,
      measured: measured && i >= shown,
    };
  });

  const centre = complete ? p.rating : p.buzz + (p.rating - p.buzz) * pull * 0.94;
  return {
    id: p.id, name: p.name, pos: p.pos, side: p.side, school: p.school, age: p.age,
    buzz: p.buzz, projected: p.projected, projRound: p.projRound,
    overallLow: spread(grade(clamp(centre - band, 25, 99)), grade(clamp(centre + band, 25, 99)))[0],
    overallHigh: spread(grade(clamp(centre - band, 25, 99)), grade(clamp(centre + band, 25, 99)))[1],
    traits,
    combine: p.combine,
    scouted: looks,
    confidence: complete ? 'complete' : looks >= 2 ? 'solid' : looks >= 1 ? 'partial' : 'none',
    exact: complete,
    ...(opts.reveal ? { trueRating: p.rating, trueGrade: grade(p.rating) } : {}),
  };
}

export function scout(prospects, id, seat) {
  const mine = seat === 'OC' ? 'offense' : 'defense';
  return prospects.map((p) => (p.id === id && p.side === mine
    ? { ...p, scouted: Math.min(SCOUT_MAX_PER_PLAYER, (p.scouted || 0) + 1) } : p));
}

/* ------------------------------------------------------------- draft order */

export function draftOrder(season) {
  const reg = season.results.filter((r) => !r.playoff);
  const rows = sortedStandings(reg).all;
  // Worst record picks first. Playoff teams slot in behind by how far they got,
  // which is how the real order is built.
  const finish = {};
  if (season.playoffs) {
    const champ = season.champion;
    for (const conf of ['N', 'S']) {
      for (const s of season.playoffs.seeds[conf]) finish[s.id] = 1;
    }
    for (const g of season.playoffs.games || []) {
      const r = season.results.find((x) => x.id === g.id);
      if (!r) continue;
      const winner = r.homeScore >= r.awayScore ? g.home : g.away;
      finish[winner] = Math.max(finish[winner] || 1, g.week - 17);
    }
    if (champ) finish[champ] = 99;
  }
  const order = [...rows].sort((a, b) =>
    (finish[a.id] || 0) - (finish[b.id] || 0) || a.pct - b.pct || a.pf - b.pf).map((r) => r.id);

  const picks = [];
  for (let round = 1; round <= ROUNDS; round++) {
    order.forEach((team, i) => picks.push({
      round, pickInRound: i + 1, overall: (round - 1) * 32 + i + 1, team,
    }));
  }
  return picks;
}

/* ------------------------------------------------------------ roster moves */

const spotsFor = (side) => (side === 'offense' ? OFF_SPOTS : DEF_SPOTS);

export function addToRoster(roster, player) {
  const side = player.side;
  const list = [...roster[side]];
  const group = list.map((cur, i) => ({ cur, i })).filter(({ cur }) => cur.pos === player.pos);
  if (!group.length) return { roster, replaced: null, kept: false, madeRoster: false };
  const worst = [...group].sort((a, b) => a.cur.rating - b.cur.rating)[0];
  // Everyone you draft joins the roster; only some of them start. Turning a
  // late pick away entirely meant most of a class vanished the moment it was
  // taken, which is not how a roster works.
  if (player.rating <= worst.cur.rating) {
    return { roster, replaced: null, kept: false, madeRoster: false };
  }

  const traitKeys = Object.keys(POSITION_TRAITS[player.pos] || {});
  const traits = player.traits && Object.fromEntries(traitKeys
    .filter((key) => Number.isFinite(player.traits[key])).map((key) => [key, player.traits[key]]));
  list[worst.i] = { ...worst.cur, name: player.name, rating: player.rating,
    ...(traits && Object.keys(traits).length ? { traits } : {}),
    development: player.development || 'normal',
    age: player.age, acquired: player.id, draftedIn: player.draftedIn ?? null };
  // Best man at the position holds the starting spot.
  const regroup = list.map((cur, i) => ({ cur, i })).filter(({ cur }) => cur.pos === player.pos);
  const ranked = [...regroup].sort((a, b) => b.cur.rating - a.cur.rating);
  const slots = regroup.map(({ cur }) => ({ spot: cur.spot, number: cur.number }))
    .sort((a, b) => spotsFor(side).findIndex((s) => s.id === a.spot)
                  - spotsFor(side).findIndex((s) => s.id === b.spot));
  // Carry every field forward. Rebuilding from spot and number alone dropped
  // age, which then showed as "undefined" on the depth chart.
  ranked.forEach((e, k) => {
    list[e.i] = { ...e.cur, spot: slots[k].spot, number: slots[k].number };
  });
  list.sort((a, b) => spotsFor(side).findIndex((s) => s.id === a.spot)
                    - spotsFor(side).findIndex((s) => s.id === b.spot));
  return { roster: { ...roster, [side]: list }, replaced: worst.cur,
    kept: true, madeRoster: true };
}

export function teamNeed(roster, side) {
  const list = roster[side];
  return list
    .map((p) => ({ spot: p.spot, pos: p.pos,
      gap: (spotsFor(side).find((s) => s.id === p.spot)?.base || 75) - p.rating }))
    .sort((a, b) => b.gap - a.gap)[0];
}

/* ------------------------------------------------------------ the war room */

/** The general manager's own read. His error is independent of yours. */
export function gmView(p, seed) {
  const rng = mulberry32(hashSeed(`${seed}:gm:${p.id}`));
  return p.rating + gauss(rng, 0, p.noise * 0.75);
}

/**
 * One pick. `pitch` is what a coordinator spent on this specific selection —
 * it moves the room, it does not run it.
 */
export function makePick(available, roster, seed, rng, pitch = {}) {
  const needOff = teamNeed(roster, 'offense');
  const needDef = teamNeed(roster, 'defense');
  const scored = available.map((p) => {
    let v = gmView(p, seed);
    const need = p.side === 'offense' ? needOff : needDef;
    if (p.pos === need.pos && need.gap > 0) v += Math.min(9, need.gap * 0.8);
    // Each point of advocacy is worth about a point and a half on his board.
    v += (pitch[p.id] || 0) * 3.2;
    return { p, v: v + gauss(rng, 0, 3.2) };
  }).sort((a, b) => b.v - a.v);
  return { pick: scored[0].p, board: scored.slice(0, 5) };
}

/** A CPU club, which cannot see true ratings either. */
export function cpuPick(available, roster, rng) {
  const needOff = teamNeed(roster, 'offense');
  const needDef = teamNeed(roster, 'defense');
  const scored = available.map((p) => {
    let v = p.buzz;
    const need = p.side === 'offense' ? needOff : needDef;
    if (p.pos === need.pos && need.gap > 0) v += Math.min(9, need.gap * 0.8);
    return { p, v: v + gauss(rng, 0, 4) };
  }).sort((a, b) => b.v - a.v);
  return scored[0].p;
}

/* ------------------------------------------------------------ progression */

export function ageRoster(roster, seed, year) {
  const step = (list) => list.map((p) => {
    const age = (p.age || 26) + 1;
    // Ageing runs after the draft, so the flag cannot simply be stripped here
    // or it would clear the class that just arrived. Stamp the year instead
    // and let the roster page decide who still counts as a rookie.
    const rest = p;
    const mean = age <= 24 ? 2.0 : age <= 27 ? 0.5 : age <= 30 ? -0.9 : -3.1;
    const sd = age <= 24 ? 2.0 : age <= 30 ? 1.8 : 2.2;
    const dev = p.development === 'quick' ? 1.30 : p.development === 'slow' ? 0.72 : 1;
    const baseTraits = p.traits || traitsFromRating(p.pos, p.rating,
      mulberry32(hashSeed(`${seed}:age-migrate:${year}:${p.name}`)));
    if (!baseTraits) {
      const rng = mulberry32(hashSeed(`${seed}:age:${year}:${p.name}:overall`));
      const delta = gauss(rng, mean > 0 ? mean * dev : mean, sd);
      return { ...rest, age, development: p.development || 'normal',
        rating: Math.round(clamp(p.rating + delta, 45, 99)) };
    }
    const traits = Object.fromEntries(Object.entries(baseTraits).map(([key, value]) => {
      const rng = mulberry32(hashSeed(`${seed}:age:${year}:${p.name}:${key}`));
      const delta = gauss(rng, mean > 0 ? mean * dev : mean, sd);
      return [key, Math.round(clamp(value + delta, 35, 99))];
    }));
    return { ...rest, age, traits, development: p.development || 'normal',
      rating: ratingFromTraits(p.pos, traits, p.rating) };
  });
  return { offense: step(roster.offense), defense: step(roster.defense) };
}
