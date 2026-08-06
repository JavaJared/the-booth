// scout.js — every number the coordinators see, derived from the play log.
// Pure functions over an array of logged plays, so both clients compute the
// same report from the same data and the server never has to send extra state.
// Slice 2 will reuse these for the résumé.
import { OFF_BY_ID, DEF_BY_ID, FAMILY_LABEL } from './playbook.js';
import { distBucket, readTendencies } from './engine.js';

/** The standard analytics definition: did the play keep the drive on schedule? */
export function isSuccess(down, distance, yards) {
  if (down === 1) return yards >= distance * 0.4;
  if (down === 2) return yards >= distance * 0.6;
  return yards >= distance;
}

/** Plays that were real snaps — no kicks, no pre-snap flags. */
const snaps = (plays) => plays.filter((p) =>
  p.outcome && !p.special && p.offId && !(p.outcome.penalty && p.outcome.penalty.replay));

export const ourOffense = (plays) => snaps(plays).filter((p) => p.possession === 'US');
export const theirOffense = (plays) => snaps(plays).filter((p) => p.possession === 'CPU');

export function inSituation(plays, state, mode = 'exact') {
  const d = state.down, b = distBucket(state.distance);
  if (mode === 'down') return plays.filter((p) => p.down === d);
  return plays.filter((p) => p.down === d && distBucket(p.distance) === b);
}

function summarise(list) {
  if (!list.length) return { n: 0, ypp: null, success: null, explosive: null, turnovers: 0 };
  const yards = list.reduce((a, p) => a + (p.outcome.yards || 0), 0);
  const wins = list.filter((p) => isSuccess(p.down, p.distance, p.outcome.yards || 0)).length;
  return {
    n: list.length,
    ypp: yards / list.length,
    success: wins / list.length,
    explosive: list.filter((p) => (p.outcome.yards || 0) >= 20).length / list.length,
    turnovers: list.filter((p) => p.outcome.turnover).length,
  };
}

/** Per-call performance for the sheet: how has this specific play gone for you? */
export function callRecord(plays, seat) {
  const rows = {};
  const list = seat === 'OC' ? ourOffense(plays) : theirOffense(plays);
  for (const p of list) {
    const key = seat === 'OC' ? p.offId : p.defId;
    if (!key) continue;
    (rows[key] = rows[key] || []).push(p);
  }
  return Object.fromEntries(Object.entries(rows).map(([k, v]) => [k, summarise(v)]));
}

/** What the opponent has done in a situation. The OC scouts coverages, the
 *  DC scouts play calls — each scouts the unit they actually face. */
export function opponentReport(plays, state, seat, mode) {
  const pool = inSituation(seat === 'OC' ? ourOffense(plays) : theirOffense(plays), state, mode);
  const rows = {};

  for (const p of pool) {
    let key, label;
    if (seat === 'OC') {
      const d = DEF_BY_ID[p.defId];
      if (!d) continue;
      key = d.id;
      label = d.name;
    } else {
      const o = OFF_BY_ID[p.offId];
      if (!o) continue;
      key = o.id;
      label = o.name;
    }
    rows[key] = rows[key] || { key, label, plays: [] };
    rows[key].plays.push(p);
  }

  const total = pool.length;
  return {
    total,
    rows: Object.values(rows)
      .map((r) => ({ ...r, share: r.plays.length / total, ...summarise(r.plays) }))
      .sort((a, b) => b.n - a.n),
  };
}

/** Coverage shells rather than specific calls — what the OC actually needs. */
export function shellReport(plays, state, mode) {
  const pool = inSituation(ourOffense(plays), state, mode);
  const buckets = {};
  for (const p of pool) {
    const d = DEF_BY_ID[p.defId];
    if (!d) continue;
    const key = d.rush > 4 ? 'pressure'
      : d.cov.startsWith('man') ? 'man'
      : d.cov === 'cover2' || d.cov === 'tampa2' ? 'two-deep'
      : d.cov === 'quarters' || d.cov === 'cover6' ? 'quarters'
      : 'single-high';
    buckets[key] = buckets[key] || { key, label: key, plays: [] };
    buckets[key].plays.push(p);
  }
  const total = pool.length;
  return {
    total,
    rows: Object.values(buckets)
      .map((b) => ({ ...b, share: b.plays.length / total, ...summarise(b.plays) }))
      .sort((a, b) => b.n - a.n),
  };
}

/** How readable you are right here. Compares what you actually call in this
 *  situation against what a defense would expect. */
export function selfScout(plays, state, tendencies) {
  const pool = inSituation(ourOffense(plays), state, 'exact');
  const counts = {};
  for (const p of pool) {
    const o = OFF_BY_ID[p.offId];
    if (o) counts[o.family] = (counts[o.family] || 0) + 1;
  }
  const total = pool.length;
  const rows = Object.entries(counts)
    .map(([family, n]) => ({ family, label: FAMILY_LABEL[family], n, share: n / total }))
    .sort((a, b) => b.share - a.share);

  const expected = readTendencies({ bySituation: {}, total: {}, plays: 0 }, state);
  const top = rows[0];
  const over = top ? top.share - (expected[top.family] || 0) : 0;
  return {
    total, rows, top,
    over,
    // Mirrors the penalty the engine actually applies in tendencyRead().
    risk: total < 4 ? 'thin' : over > 0.28 ? 'high' : over > 0.12 ? 'some' : 'low',
  };
}

export function unitSummary(plays) {
  const off = ourOffense(plays), def = theirOffense(plays);
  const third = (list) => {
    const a = list.filter((p) => p.down === 3);
    return a.length ? a.filter((p) => (p.outcome.yards || 0) >= p.distance).length / a.length : null;
  };
  return {
    offense: { ...summarise(off), third: third(off) },
    defense: { ...summarise(def), third: third(def) },
  };
}
