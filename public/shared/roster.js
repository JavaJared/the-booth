// roster.js — a light player layer, so a box score means something.
// Rosters are generated deterministically from a seed stored on the game, which
// keeps 40 player objects out of Firestore while letting both the server and
// every client reproduce the identical roster.
import { mulberry32, hashSeed } from './engine.js';
import { FIRST, LAST, RESERVED } from './names.js';

// role: how the position is used. base: rating centre. spread: how much it varies.
/**
 * A real depth chart. The first man at each position is the starter the play
 * engine reads; everyone behind him is depth that matters for the draft, for
 * ageing, and for knowing where the roster is thin. `key` marks the spots the
 * engine actually resolves plays with.
 */
export const OFF_SPOTS = [
  { id: 'QB',  label: 'QB',  base: 78, spread: 8, nums: [[1, 19]], key: true },
  { id: 'QB2', label: 'QB',  base: 66, spread: 8, nums: [[1, 19]] },
  { id: 'QB3', label: 'QB',  base: 58, spread: 7, nums: [[1, 19]] },
  { id: 'RB1', label: 'RB',  base: 77, spread: 8, nums: [[20, 39]], key: true },
  { id: 'RB2', label: 'RB',  base: 70, spread: 7, nums: [[20, 39]], key: true },
  { id: 'RB3', label: 'RB',  base: 63, spread: 7, nums: [[20, 39]] },
  { id: 'FB',  label: 'RB',  base: 66, spread: 6, nums: [[40, 49]] },
  { id: 'WR1', label: 'WR',  base: 81, spread: 8, nums: [[10, 19], [80, 89]], key: true },
  { id: 'WR2', label: 'WR',  base: 75, spread: 8, nums: [[10, 19], [80, 89]], key: true },
  { id: 'WR3', label: 'WR',  base: 71, spread: 8, nums: [[10, 19], [80, 89]], key: true },
  { id: 'WR4', label: 'WR',  base: 66, spread: 8, nums: [[10, 19], [80, 89]] },
  { id: 'WR5', label: 'WR',  base: 61, spread: 7, nums: [[10, 19], [80, 89]] },
  { id: 'WR6', label: 'WR',  base: 57, spread: 7, nums: [[10, 19], [80, 89]] },
  { id: 'TE1', label: 'TE',  base: 75, spread: 8, nums: [[40, 49], [84, 89]], key: true },
  { id: 'TE2', label: 'TE',  base: 67, spread: 7, nums: [[40, 49], [84, 89]], key: true },
  { id: 'TE3', label: 'TE',  base: 60, spread: 7, nums: [[40, 49], [84, 89]] },
  { id: 'OL',  label: 'OL',  base: 76, spread: 6, nums: [[60, 79]], key: true },
  { id: 'OL2', label: 'OL',  base: 75, spread: 6, nums: [[60, 79]] },
  { id: 'OL3', label: 'OL',  base: 74, spread: 6, nums: [[60, 79]] },
  { id: 'OL4', label: 'OL',  base: 73, spread: 6, nums: [[60, 79]] },
  { id: 'OL5', label: 'OL',  base: 72, spread: 6, nums: [[60, 79]] },
  { id: 'OL6', label: 'OL',  base: 65, spread: 6, nums: [[60, 79]] },
  { id: 'OL7', label: 'OL',  base: 62, spread: 6, nums: [[60, 79]] },
  { id: 'OL8', label: 'OL',  base: 58, spread: 6, nums: [[60, 79]] },
  { id: 'OL9', label: 'OL',  base: 55, spread: 6, nums: [[60, 79]] },
  { id: 'K',   label: 'K',   base: 74, spread: 7, nums: [[1, 9]] },
  { id: 'P',   label: 'P',   base: 72, spread: 7, nums: [[1, 9]] },
];
export const DEF_SPOTS = [
  { id: 'EDGE1', label: 'EDGE', base: 79, spread: 8, nums: [[50, 59], [90, 99]], key: true },
  { id: 'EDGE2', label: 'EDGE', base: 73, spread: 8, nums: [[50, 59], [90, 99]], key: true },
  { id: 'EDGE3', label: 'EDGE', base: 66, spread: 7, nums: [[50, 59], [90, 99]] },
  { id: 'EDGE4', label: 'EDGE', base: 60, spread: 7, nums: [[50, 59], [90, 99]] },
  { id: 'DT',    label: 'DT',   base: 76, spread: 7, nums: [[60, 79], [90, 99]], key: true },
  { id: 'DT2',   label: 'DT',   base: 72, spread: 7, nums: [[60, 79], [90, 99]] },
  { id: 'DT3',   label: 'DT',   base: 66, spread: 7, nums: [[60, 79], [90, 99]] },
  { id: 'DT4',   label: 'DT',   base: 59, spread: 7, nums: [[60, 79], [90, 99]] },
  { id: 'LB1',   label: 'LB',   base: 77, spread: 8, nums: [[40, 59]], key: true },
  { id: 'LB2',   label: 'LB',   base: 71, spread: 7, nums: [[40, 59]], key: true },
  { id: 'LB3',   label: 'LB',   base: 65, spread: 7, nums: [[40, 59]] },
  { id: 'LB4',   label: 'LB',   base: 60, spread: 7, nums: [[40, 59]] },
  { id: 'LB5',   label: 'LB',   base: 56, spread: 7, nums: [[40, 59]] },
  { id: 'CB1',   label: 'CB',   base: 80, spread: 9, nums: [[20, 39]], key: true },
  { id: 'CB2',   label: 'CB',   base: 73, spread: 9, nums: [[20, 39]], key: true },
  { id: 'CB3',   label: 'CB',   base: 66, spread: 8, nums: [[20, 39]] },
  { id: 'CB4',   label: 'CB',   base: 60, spread: 7, nums: [[20, 39]] },
  { id: 'CB5',   label: 'CB',   base: 56, spread: 7, nums: [[20, 39]] },
  { id: 'NB',    label: 'NB',   base: 71, spread: 8, nums: [[20, 39]], key: true },
  { id: 'NB2',   label: 'NB',   base: 62, spread: 7, nums: [[20, 39]] },
  { id: 'S1',    label: 'S',    base: 77, spread: 8, nums: [[20, 49]], key: true },
  { id: 'S2',    label: 'S',    base: 72, spread: 8, nums: [[20, 49]], key: true },
  { id: 'S3',    label: 'S',    base: 64, spread: 7, nums: [[20, 49]] },
  { id: 'S4',    label: 'S',    base: 58, spread: 7, nums: [[20, 49]] },
  { id: 'LB6',   label: 'LB',   base: 54, spread: 7, nums: [[40, 59]] },
  { id: 'LS',    label: 'LS',   base: 68, spread: 6, nums: [[40, 59]] },
];

/** The spots the play engine actually resolves with. */
export const KEY_OFF = OFF_SPOTS.filter((s) => s.key).map((s) => s.id);
export const KEY_DEF = DEF_SPOTS.filter((s) => s.key).map((s) => s.id);

function gauss(rng, mean, sd) {
  let u = 0, v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return mean + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** Draw a name that is neither already on a roster nor a real player's.
 *  At 364,000 combinations the real-player collision stops being hypothetical
 *  over a long career mode, so it is checked rather than hoped away. */
function drawName(rng, used) {
  for (let i = 0; i < 60; i++) {
    const name = `${FIRST[Math.floor(rng() * FIRST.length)]} ${LAST[Math.floor(rng() * LAST.length)]}`;
    if (!used.has(name) && !RESERVED.has(name.toLowerCase())) { used.add(name); return name; }
  }
  // Effectively unreachable, but never hand back a duplicate.
  let n = 2, base = `${FIRST[Math.floor(rng() * FIRST.length)]} ${LAST[Math.floor(rng() * LAST.length)]}`;
  while (used.has(`${base} ${'I'.repeat(n)}`)) n++;
  const name = `${base} ${'I'.repeat(n)}`;
  used.add(name);
  return name;
}

function drawNumber(rng, ranges, taken) {
  for (let i = 0; i < 40; i++) {
    const [lo, hi] = ranges[Math.floor(rng() * ranges.length)];
    const n = lo + Math.floor(rng() * (hi - lo + 1));
    if (!taken.has(n)) { taken.add(n); return n; }
  }
  for (let n = 1; n < 100; n++) if (!taken.has(n)) { taken.add(n); return n; }
  return 0;
}

function build(rng, spots, used, taken) {
  return spots.map((s) => ({
    spot: s.id,
    pos: s.label,
    name: drawName(rng, used),
    rating: Math.round(Math.max(52, Math.min(97, gauss(rng, s.base, s.spread)))),
    number: drawNumber(rng, s.nums, taken),
    // Real ages, so ageing between seasons is roughly neutral league-wide.
    // Without this everyone was treated as 26 and improved every year.
    age: Math.round(Math.max(21, Math.min(36, gauss(rng, 26.5, 3.4)))),
  }));
}

/** Both teams, offense and defense, from one seed. */
export function makeRosters(seed) {
  const r = (tag) => mulberry32(hashSeed(`${seed}:${tag}`));
  // Names are unique across the whole game; numbers only within a team.
  const used = new Set();
  const usNums = new Set(), cpuNums = new Set();
  return {
    US: {
      offense: build(r('us-off'), OFF_SPOTS, used, usNums),
      defense: build(r('us-def'), DEF_SPOTS, used, usNums),
    },
    CPU: {
      offense: build(r('cpu-off'), OFF_SPOTS, used, cpuNums),
      defense: build(r('cpu-def'), DEF_SPOTS, used, cpuNums),
    },
  };
}

export const bySpot = (list) => Object.fromEntries(list.map((p) => [p.spot, p]));

/**
 * Every roster in the league, generated once when the league is created.
 * Names are unique league-wide, which a per-team call could not guarantee —
 * at 32 teams the birthday problem produces collisions otherwise.
 * Generated deterministically so a league is reproducible from its seed, then
 * stored: once free agency and the draft exist, rosters stop being a pure
 * function of the seed and the stored copy becomes the truth.
 */
export function makeLeagueRosters(seed, teamIds) {
  const used = new Set();
  const out = {};
  for (const id of teamIds) {
    const nums = new Set();
    out[id] = {
      offense: build(mulberry32(hashSeed(`${seed}:${id}:off`)), OFF_SPOTS, used, nums),
      defense: build(mulberry32(hashSeed(`${seed}:${id}:def`)), DEF_SPOTS, used, nums),
    };
  }
  return out;
}

/** Collapse a roster into the two numbers a fast simulation needs. */
export function teamStrength(roster) {
  const o = bySpot(roster.offense), d = bySpot(roster.defense);
  const avg = (...ps) => ps.reduce((a, p) => a + (p?.rating || 75), 0) / ps.length;
  return {
    off: 0.30 * (o.QB?.rating || 75)
       + 0.34 * avg(o.WR1, o.WR2, o.WR3, o.TE1, o.RB1)
       + 0.36 * (o.OL?.rating || 75),
    def: 0.50 * avg(d.EDGE1, d.EDGE2, d.DT, d.LB1, d.LB2)
       + 0.50 * avg(d.CB1, d.CB2, d.NB, d.S1, d.S2),
  };
}

/** Who the coverage puts on a given receiver. In zone the matchup softens,
 *  because no single defender owns him. */
const MAN_ASSIGN = { WR1: 'CB1', WR2: 'CB2', WR3: 'NB', TE1: 'S1', TE2: 'LB1', RB1: 'LB2', RB2: 'LB2', QB: 'LB1' };
const ZONE_POOL = ['CB1', 'CB2', 'NB', 'S1', 'S2', 'LB1', 'LB2'];

export function coverDefender(targetSpot, def, defRoster) {
  // The same defender owns the receiver either way, so box-score credit stays
  // coherent. Zone softens the matchup in talentEdge instead of randomising
  // who covered him, which was mostly adding noise.
  return bySpot(defRoster)[MAN_ASSIGN[targetSpot] || 'S1'];
}

/** In zone nobody owns a receiver alone, so his cover man's rating is blended
 *  toward the back seven as a whole. */
function effectiveCover(defender, defRoster, man) {
  const base = defender?.rating || 75;
  if (man) return base;
  const pool = ZONE_POOL.map((s) => bySpot(defRoster)[s]).filter(Boolean);
  const avg = pool.reduce((a, p) => a + p.rating, 0) / (pool.length || 1);
  return base * 0.55 + avg * 0.45;
}

/** Pick who touches the ball, from the concept's own target distribution. */
export function pickTarget(off, offRoster, rng) {
  const spots = off.targets || { RB1: 1 };
  const total = Object.values(spots).reduce((a, b) => a + b, 0);
  let r = rng() * total;
  for (const [spot, w] of Object.entries(spots)) { r -= w; if (r <= 0) return bySpot(offRoster)[spot]; }
  return bySpot(offRoster).RB1;
}

/** Who makes the play on defense when it isn't a coverage snap. */
export function pickTackler(off, def, defRoster, rng) {
  const d = bySpot(defRoster);
  const front = off.edge === 'outside'
    ? ['EDGE1', 'EDGE2', 'LB1', 'LB2', 'S1', 'CB1']
    : ['DT', 'LB1', 'LB2', 'EDGE1', 'EDGE2', 'S1'];
  const weights = off.edge === 'outside' ? [3, 3, 4, 3, 2, 1] : [4, 4, 3, 2, 2, 1];
  const total = weights.reduce((a, b) => a + b, 0);
  let r = rng() * total;
  for (let i = 0; i < front.length; i++) { r -= weights[i]; if (r <= 0) return d[front[i]]; }
  return d.LB1;
}

/** Who got home. Blitzers rush more, so they get more chances at the QB. */
export function pickRusher(def, defRoster, rng) {
  const d = bySpot(defRoster);
  const pool = ['EDGE1', 'EDGE1', 'EDGE2', 'DT'];
  if (def.rush > 4) pool.push('LB1', 'LB2');
  if (def.rush > 5) pool.push('NB', 'S2');
  return d[pool[Math.floor(rng() * pool.length)]] || d.EDGE1;
}

/**
 * How much the people on the field move the needle. Deliberately modest —
 * scheme should stay the bigger lever, or the play-calling game evaporates.
 * A 90 receiver on a 65 corner is worth about +0.11 edge in man; the coverage
 * matchup itself swings roughly twice that.
 */
export function talentEdge(off, def, target, defender, offRoster, defRoster) {
  const o = bySpot(offRoster);
  if (off.family === 'run') {
    return ((o.OL?.rating || 75) - 75) / 300 + ((target?.rating || 75) - 75) / 340;
  }
  const man = def.cov.startsWith('man');
  const cover = defRoster ? effectiveCover(defender, defRoster, man) : (defender?.rating || 75);
  const matchup = ((target?.rating || 75) - cover) / 100 * (man ? 0.16 : 0.10);
  const qb = ((o.QB?.rating || 75) - 75) / 300;
  return matchup + qb;
}

/** The matchup board: who covers whom, and by how much. Same numbers the
 *  resolver uses, so the board can never disagree with the game. */
export function matchupBoard(offRoster, defRoster, man = true) {
  const d = bySpot(defRoster);
  return Object.entries(MAN_ASSIGN)
    .filter(([spot]) => spot.startsWith('WR') || spot.startsWith('TE') || spot === 'RB1')
    .map(([spot, dSpot]) => {
      const t = bySpot(offRoster)[spot], v = d[dSpot];
      if (!t || !v) return null;
      return { target: t, defender: v,
        gap: t.rating - effectiveCover(v, defRoster, man),
        manGap: t.rating - v.rating };
    })
    .filter(Boolean)
    .sort((a, b) => b.manGap - a.manGap);
}

/** Pass protection: a good line buys the quarterback time. */
export const protectionFactor = (offRoster) => 1 - ((bySpot(offRoster).OL?.rating || 75) - 75) / 300;
