// roster.js — a light player layer, so a box score means something.
// Rosters are generated deterministically from a seed stored on the game, which
// keeps 40 player objects out of Firestore while letting both the server and
// every client reproduce the identical roster.
import { mulberry32, hashSeed } from './engine.js';

const FIRST = ['Marcus','Dre','Elijah','Cade','Trevon','Jalen','Beau','Isaiah','Rashad','Nico',
  'Griffin','Amari','Devonte','Luka','Kingsley','Tanner','Emeka','Roman','Silas','Kobe',
  'Xavier','Damari','Foster','Jaxon','Terrence','Quinn','Malachi','Bodie','Zion','Auden'];
const LAST = ['Whitlock','Ferreira','Boateng','Nakamura','Alvarez','Pruitt','Okafor','Lindqvist',
  'Castellano','Ryder','Abaimov','Delacroix','Mbeki','Sorensen','Vasquez','Hollins','Tanaka',
  'Kowalski','Ibarra','Feldman','Duarte','Nwosu','Sandoval','Kilgore','Petrov','Achebe',
  'Larkin','Osei','Vitale','Ranganathan'];

// role: how the position is used. base: rating centre. spread: how much it varies.
export const OFF_SPOTS = [
  { id: 'QB',  label: 'QB',  base: 78, spread: 8 },
  { id: 'RB1', label: 'RB',  base: 77, spread: 8 },
  { id: 'RB2', label: 'RB',  base: 70, spread: 7 },
  { id: 'WR1', label: 'WR',  base: 81, spread: 8 },
  { id: 'WR2', label: 'WR',  base: 75, spread: 8 },
  { id: 'WR3', label: 'WR',  base: 71, spread: 8 },
  { id: 'TE1', label: 'TE',  base: 75, spread: 8 },
  { id: 'TE2', label: 'TE',  base: 67, spread: 7 },
  { id: 'OL',  label: 'OL',  base: 76, spread: 6 },
];
export const DEF_SPOTS = [
  { id: 'EDGE1', label: 'EDGE', base: 79, spread: 8 },
  { id: 'EDGE2', label: 'EDGE', base: 73, spread: 8 },
  { id: 'DT',    label: 'DT',   base: 76, spread: 7 },
  { id: 'LB1',   label: 'LB',   base: 77, spread: 8 },
  { id: 'LB2',   label: 'LB',   base: 71, spread: 7 },
  { id: 'CB1',   label: 'CB',   base: 80, spread: 9 },
  { id: 'CB2',   label: 'CB',   base: 73, spread: 9 },
  { id: 'NB',    label: 'NB',   base: 71, spread: 8 },
  { id: 'S1',    label: 'S',    base: 77, spread: 8 },
  { id: 'S2',    label: 'S',    base: 72, spread: 8 },
];

function gauss(rng, mean, sd) {
  let u = 0, v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return mean + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function build(rng, spots) {
  const used = new Set();
  return spots.map((s) => {
    let name;
    do {
      name = `${FIRST[Math.floor(rng() * FIRST.length)]} ${LAST[Math.floor(rng() * LAST.length)]}`;
    } while (used.has(name));
    used.add(name);
    return {
      spot: s.id, pos: s.label, name,
      rating: Math.round(Math.max(52, Math.min(97, gauss(rng, s.base, s.spread)))),
      number: 1 + Math.floor(rng() * 98),
    };
  });
}

/** Both teams, offense and defense, from one seed. */
export function makeRosters(seed) {
  const r = (tag) => mulberry32(hashSeed(`${seed}:${tag}`));
  return {
    US: { offense: build(r('us-off'), OFF_SPOTS), defense: build(r('us-def'), DEF_SPOTS) },
    CPU: { offense: build(r('cpu-off'), OFF_SPOTS), defense: build(r('cpu-def'), DEF_SPOTS) },
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
