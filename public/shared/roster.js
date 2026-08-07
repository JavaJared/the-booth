// roster.js — a light player layer, so a box score means something.
// Rosters are generated deterministically from a seed stored on the game, which
// keeps 40 player objects out of Firestore while letting both the server and
// every client reproduce the identical roster.
import { mulberry32, hashSeed } from './engine.js';
import { FIRST, LAST, RESERVED } from './names.js';

// role: how the position is used. base: rating centre. spread: how much it varies.
export const OFF_SPOTS = [
  { id: 'QB',  label: 'QB',  base: 78, spread: 8, nums: [[1, 19]] },
  { id: 'RB1', label: 'RB',  base: 77, spread: 8, nums: [[20, 39]] },
  { id: 'RB2', label: 'RB',  base: 70, spread: 7, nums: [[20, 39]] },
  { id: 'WR1', label: 'WR',  base: 81, spread: 8, nums: [[10, 19], [80, 89]] },
  { id: 'WR2', label: 'WR',  base: 75, spread: 8, nums: [[10, 19], [80, 89]] },
  { id: 'WR3', label: 'WR',  base: 71, spread: 8, nums: [[10, 19], [80, 89]] },
  { id: 'TE1', label: 'TE',  base: 75, spread: 8, nums: [[40, 49], [84, 89]] },
  { id: 'TE2', label: 'TE',  base: 67, spread: 7, nums: [[40, 49], [84, 89]] },
  { id: 'OL',  label: 'OL',  base: 76, spread: 6, nums: [[60, 79]] },
];
export const DEF_SPOTS = [
  { id: 'EDGE1', label: 'EDGE', base: 79, spread: 8, nums: [[50, 59], [90, 99]] },
  { id: 'EDGE2', label: 'EDGE', base: 73, spread: 8, nums: [[50, 59], [90, 99]] },
  { id: 'DT',    label: 'DT',   base: 76, spread: 7, nums: [[60, 79], [90, 99]] },
  { id: 'LB1',   label: 'LB',   base: 77, spread: 8, nums: [[40, 59]] },
  { id: 'LB2',   label: 'LB',   base: 71, spread: 7, nums: [[40, 59]] },
  { id: 'CB1',   label: 'CB',   base: 80, spread: 9, nums: [[20, 39]] },
  { id: 'CB2',   label: 'CB',   base: 73, spread: 9, nums: [[20, 39]] },
  { id: 'NB',    label: 'NB',   base: 71, spread: 8, nums: [[20, 39]] },
  { id: 'S1',    label: 'S',    base: 77, spread: 8, nums: [[20, 49]] },
  { id: 'S2',    label: 'S',    base: 72, spread: 8, nums: [[20, 49]] },
];

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
