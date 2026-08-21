// engine.js — pure, deterministic football simulation.
// Every function here must be side-effect free and reproducible from (state, calls, seed).
// The same file runs inside Cloud Functions (authoritative) and in the browser (local mode).

import {
  OFFENSE, DEFENSE, OFF_BY_ID, DEF_BY_ID,
  FAMILIES, PERS_WEIGHT, DEF_PERS_WEIGHT,
} from './playbook.js';
import {
  pickTarget, coverDefender, pickTackler, pickRusher, talentEdge, protectionFactor, bySpot,
} from './roster.js';
import { spatialMatchup } from './spatial.js';

// ---------------------------------------------------------------- RNG
export function hashSeed(str) {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return h >>> 0;
}

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gauss(rng, mean, sd) {
  let u = 0, v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return mean + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

// ---------------------------------------------------------------- Situation
export function distBucket(distance) {
  if (distance <= 2) return 'short';
  if (distance <= 6) return 'med';
  return 'long';
}

export function fieldZone(ballOn) {
  if (ballOn <= 20) return 'backedUp';
  if (ballOn >= 80) return 'redZone';
  if (ballOn >= 60) return 'fringe';
  return 'open';
}

export function situationKey(state) {
  return `${state.down}-${distBucket(state.distance)}-${fieldZone(state.ballOn)}`;
}

// League-average family priors by down and distance. The CPU defense starts
// here and then bends toward whatever the human coordinator actually does.
const PRIORS = {
  '1-short': { run: 0.571, quick: 0.124, screen: 0.038, dropback: 0.133, playaction: 0.095, shot: 0.038 },
  '1-med':   { run: 0.528, quick: 0.142, screen: 0.038, dropback: 0.16, playaction: 0.094, shot: 0.038 },
  '1-long':  { run: 0.476, quick: 0.152, screen: 0.048, dropback: 0.19, playaction: 0.086, shot: 0.048 },
  '2-short': { run: 0.6, quick: 0.114, screen: 0.038, dropback: 0.124, playaction: 0.086, shot: 0.038 },
  '2-med':   { run: 0.449, quick: 0.168, screen: 0.047, dropback: 0.215, playaction: 0.084, shot: 0.037 },
  '2-long':  { run: 0.283, quick: 0.189, screen: 0.075, dropback: 0.321, playaction: 0.075, shot: 0.057 },
  '3-short': { run: 0.52, quick: 0.22, screen: 0.03, dropback: 0.16, playaction: 0.05, shot: 0.02 },
  '3-med':   { run: 0.14, quick: 0.28, screen: 0.07, dropback: 0.42, playaction: 0.05, shot: 0.04 },
  '3-long':  { run: 0.07, quick: 0.2, screen: 0.1, dropback: 0.53, playaction: 0.03, shot: 0.07 },
  '4-short': { run: 0.62, quick: 0.18, screen: 0.02, dropback: 0.14, playaction: 0.03, shot: 0.01 },
  '4-med':   { run: 0.18, quick: 0.26, screen: 0.06, dropback: 0.42, playaction: 0.04, shot: 0.04 },
  '4-long':  { run: 0.08, quick: 0.2, screen: 0.08, dropback: 0.53, playaction: 0.03, shot: 0.08 },
};

function priorFor(state) {
  return PRIORS[`${state.down}-${distBucket(state.distance)}`] || PRIORS['1-med'];
}

// ---------------------------------------------------------------- Tendencies
export function emptyTendencies() {
  return { bySituation: {}, total: {}, plays: 0 };
}

export function recordTendency(t, state, family) {
  const key = `${state.down}-${distBucket(state.distance)}`;
  t.bySituation[key] = t.bySituation[key] || {};
  t.bySituation[key][family] = (t.bySituation[key][family] || 0) + 1;
  t.total[family] = (t.total[family] || 0) + 1;
  t.plays = (t.plays || 0) + 1;
  return t;
}

// Blend of prior and observed behaviour. Returns a probability per family.
export function readTendencies(t, state) {
  const prior = priorFor(state);
  const key = `${state.down}-${distBucket(state.distance)}`;
  const obs = (t && t.bySituation[key]) || {};
  const n = Object.values(obs).reduce((a, b) => a + b, 0);
  const w = n / (n + 5); // needs real sample size before it overrides the prior
  const out = {};
  for (const f of FAMILIES) {
    const share = n ? (obs[f] || 0) / n : 0;
    out[f] = (1 - w) * prior[f] + w * share;
  }
  return out;
}

// How much of this game has been run. Feeds play-action credibility.
function runEstablishment(t) {
  if (!t || !t.plays) return 0.45;
  return (t.total.run || 0) / t.plays;
}

// ---------------------------------------------------------------- Matchup edge
// Positive edge favours the offense. Used by resolution AND by the CPU's
// decision-making, so the AI is always reasoning with the real numbers.
export function computeEdge(off, def, ctx = {}) {
  const extraRush = def.rush - 4;
  const persEdge = (PERS_WEIGHT[off.pers] - DEF_PERS_WEIGHT[def.pers]) * 0.022;
  const readEdge = ctx.readEdge || 0;
  const planEdge = ctx.planEdge || 0;
  const designEdge = ctx.spatialEdge ?? spatialMatchup(off, def).edge;

  if (off.family === 'run') {
    const boxEdge = (7 - def.box) * 0.048 * off.boxFit;
    const commit = -def.runCommit * 0.26 * off.boxFit;
    // Outside runs care less about box count, more about defensive width.
    const edgeRun = off.edge === 'outside' ? (def.pers === 'heavy' ? 0.05 : 0) : 0;
    return boxEdge + commit + edgeRun + persEdge + readEdge + planEdge + designEdge;
  }

  const covEdge = off.vs[def.cov] || 0;
  const blitzEdge = off.blitzFit * extraRush * 0.055;
  // Play action sells against a defense that has committed to the run.
  const pa = off.paBonus
    ? off.paBonus * (def.runCommit * 0.20 + (runEstablishment(ctx.tendencies) - 0.42) * 0.16)
    : 0;
  return covEdge + blitzEdge + pa - persEdge * 0.5 + readEdge + planEdge + designEdge;
}

// Penalty the offense pays for being predictable, scaled by how far the
// defense leaned the right way.
function tendencyRead(off, def, tendencies, state) {
  const probs = readTendencies(tendencies, state);
  const p = probs[off.family] || 0;
  const prior = priorFor(state)[off.family] || 0.1;
  const surprise = p - prior; // >0 means this coordinator over-uses it here
  if (surprise <= 0.04) return 0;

  // Did the defense actually commit toward this family?
  const lean = off.family === 'run'
    ? def.runCommit + (def.box - 7) * 0.12
    : (def.rush - 4) * 0.10 - def.runCommit * 0.6;
  return -clamp(surprise, 0, 0.5) * clamp(lean, -1, 1) * 0.55;
}

// ---------------------------------------------------------------- Resolution
const PENALTIES = [
  { id: 'hold', name: 'Holding, offense', yards: -10, replay: true, on: 'off', w: 22 },
  { id: 'fs', name: 'False start', yards: -5, replay: true, on: 'off', w: 20 },
  { id: 'ineligible', name: 'Illegal formation', yards: -5, replay: true, on: 'off', w: 6 },
  { id: 'offside', name: 'Offside, defense', yards: 5, replay: true, on: 'def', w: 16 },
  { id: 'dhold', name: 'Defensive holding', yards: 5, replay: false, on: 'def', w: 12 },
  { id: 'dpi', name: 'Pass interference', yards: 0, spot: true, replay: false, on: 'def', w: 10 },
  { id: 'facemask', name: 'Facemask', yards: 15, replay: false, on: 'def', w: 4 },
];

function rollPenalty(rng, isPass) {
  if (rng() > 0.105) return null;
  const pool = PENALTIES.filter((p) => (p.id === 'dpi' ? isPass : true));
  const total = pool.reduce((a, p) => a + p.w, 0);
  let r = rng() * total;
  for (const p of pool) { r -= p.w; if (r <= 0) return p; }
  return pool[0];
}

/**
 * Resolve one snap. Returns a plain outcome object — this function never
 * mutates state. `advance()` applies the outcome.
 */
export function resolveSnap(state, offId, defId, rng, tendencies, plans = {}) {
  const off = OFF_BY_ID[offId];
  const def = DEF_BY_ID[defId];
  if (!off || !def) throw new Error(`unknown call ${offId} / ${defId}`);

  const readEdge = tendencyRead(off, def, tendencies, state);
  const planEdge = planEdgeFor(off, plans.offense);
  const design = spatialMatchup(off, def);

  // Who is actually on the field for this snap.
  const offRoster = plans.offRoster, defRoster = plans.defRoster;
  let cast = null, talent = 0, targetDesignEdge = 0;
  if (offRoster && defRoster) {
    const target = pickTarget({ ...off, targets: design.targetWeights }, offRoster, rng);
    targetDesignEdge = clamp((design.reads[target?.spot] || 0) * 0.025, -0.025, 0.025);
    const defender = off.family === 'run'
      ? pickTackler(off, def, defRoster, rng)
      : coverDefender(target?.spot, def, defRoster);
    cast = { target, defender, qb: bySpot(offRoster).QB, rusher: pickRusher(def, defRoster, rng) };
    talent = talentEdge(off, def, target, defender, offRoster, defRoster);
  }

  const exactEdge = clamp(design.edge + targetDesignEdge, -0.11, 0.11);
  const edge = computeEdge(off, def, {
    readEdge, planEdge, tendencies, spatialEdge: exactEdge,
  }) + talent;

  const base = {
    offId, defId, offName: off.name, defName: def.name,
    family: off.family, edge: +edge.toFixed(3), readEdge: +readEdge.toFixed(3),
    talent: +talent.toFixed(3), designEdge: +exactEdge.toFixed(3),
    yards: 0, turnover: null, complete: null, sack: false, touchdown: false,
    outOfBounds: false, clockStops: false, penalty: null,
  };

  // Penalty check first — a pre-snap flag replaces the play entirely.
  const pen = rollPenalty(rng, off.family !== 'run');
  if (pen && (pen.id === 'fs' || pen.id === 'offside' || pen.id === 'ineligible')) {
    return { ...base, penalty: { ...pen }, yards: 0, clockStops: true, deadBall: true,
      desc: `${pen.name}. ${pen.yards > 0 ? '+' : ''}${pen.yards} yards, replay the down.` };
  }

  const res = off.family === 'run'
    ? resolveRun(off, def, edge, rng)
    : resolvePass(off, def, edge, rng, offRoster, design);

  const out = { ...base, ...res };
  if (cast) out.cast = creditPlay(off, out, cast);

  // Post-snap penalty on a live play.
  if (pen && !out.turnover && pen.id !== 'fs' && pen.id !== 'offside' && pen.id !== 'ineligible') {
    if (pen.on === 'off') {
      out.penalty = { ...pen };
      out.yards = pen.yards;
      out.complete = null; out.sack = false;
      out.desc = `${pen.name} wipes out the play. ${pen.yards} yards, replay the down.`;
    } else if (pen.id === 'dpi' && out.complete === false) {
      const spot = Math.round(clamp(gauss(rng, off.mean + 3, 5), 3, 45));
      out.penalty = { ...pen, yards: spot };
      out.yards = spot; out.complete = null; out.firstDown = true;
      out.desc = `Pass interference — ${spot} yard penalty, automatic first down.`;
    } else if (out.complete === false || out.sack) {
      out.penalty = { ...pen };
      out.yards = pen.yards; out.sack = false; out.complete = null; out.firstDown = true;
      out.desc = `${pen.name} — ${pen.yards} yards, automatic first down.`;
    }
  }

  return out;
}

/** Turn an outcome into a line in the box score. */
function creditPlay(off, out, cast) {
  const nm = (p) => (p ? { name: p.name, pos: p.pos, spot: p.spot, rating: p.rating, number: p.number } : null);
  const c = { defender: nm(cast.defender) };
  if (off.family === 'run') {
    c.carrier = nm(cast.target);
    if (out.turnover === 'fumble') c.forced = nm(cast.defender);
    else c.tackler = nm(cast.defender);
  } else if (out.sack) {
    c.passer = nm(cast.qb);
    c.sacker = nm(cast.rusher);
    if (out.turnover === 'fumble') c.forced = nm(cast.rusher);
  } else {
    c.passer = nm(cast.qb);
    c.target = nm(cast.target);
    if (out.turnover === 'interception') c.interceptor = nm(cast.defender);
    else if (out.complete) c.tackler = nm(cast.defender);
    else if (out.complete === false) c.breakup = nm(cast.defender);
  }
  return c;
}

function planEdgeFor(off, plan) {
  if (!plan) return 0;
  // aggression: -1 conservative .. +1 aggressive
  const a = plan.aggression || 0;
  const deep = off.family === 'shot' || off.family === 'playaction';
  const safe = off.family === 'quick' || off.family === 'screen';
  if (deep) return a * 0.03;
  if (safe) return -a * 0.02;
  return 0;
}

function resolveRun(off, def, edge, rng) {
  const stuffP = clamp(off.stuff - edge * 0.55, 0.03, 0.45);
  if (rng() < stuffP) {
    const y = Math.round(clamp(gauss(rng, -1.4, 1.7), -8, 1));
    return { yards: y, desc: y < 0 ? `Stuffed for a loss of ${-y}.` : 'No gain.' };
  }
  if (rng() < off.fumble * (1 + Math.max(0, -edge) * 2)) {
    const y = Math.round(clamp(gauss(rng, 2, 2), -2, 8));
    if (rng() < 0.52) return { yards: y, turnover: 'fumble', desc: `Ball is out — recovered by the defense after ${y}.` };
    return { yards: y, desc: `Fumble! Offense recovers after a gain of ${y}.` };
  }
  let y = gauss(rng, off.mean * (1 + 1.25 * edge), off.sd);
  const breakP = 0.042 + Math.max(0, edge) * 0.40;
  if (rng() < breakP) y += Math.abs(gauss(rng, 14, 11));
  y = Math.round(clamp(y, -3, 99));
  return { yards: y, desc: y >= 15 ? `Breaks through for ${y}.` : `Gain of ${y}.` };
}

function resolvePass(off, def, edge, rng, offRoster, design = {}) {
  const extraRush = def.rush - 4;
  const protection = (1 - 0.045 * PERS_WEIGHT[off.pers]) * (offRoster ? protectionFactor(offRoster) : 1);
  const sackP = clamp(
    off.sack * (1 + 0.55 * extraRush * (1 - off.blitzFit)) * protection
      * clamp(1 - (design.pressure || 0) * 4, 0.75, 1.3),
    0.005, 0.30
  );
  if (rng() < sackP) {
    const y = -Math.round(clamp(Math.abs(gauss(rng, 7, 2.6)), 1, 16));
    if (rng() < 0.045) return { yards: y, turnover: 'fumble', sack: true, desc: `Strip sack! Defense recovers.` };
    return { yards: y, sack: true, desc: `Sacked for a loss of ${-y}.` };
  }

  const intP = clamp(off.int * (1 - 1.7 * edge) * (extraRush >= 2 ? 1.15 : 1), 0.003, 0.14);
  if (rng() < intP) {
    const ret = Math.round(clamp(Math.abs(gauss(rng, 8, 9)), 0, 60));
    return { yards: 0, turnover: 'interception', returnYards: ret, clockStops: true,
      desc: `Intercepted! Returned ${ret} yards.` };
  }

  const compP = clamp(off.comp + edge, 0.12, 0.94);
  if (rng() >= compP) {
    return { yards: 0, complete: false, clockStops: true, desc: 'Incomplete.' };
  }

  let y = gauss(rng, off.mean * (1 + 1.05 * edge), off.sd);
  const explP = clamp(off.expl * (1 + 2.4 * edge), 0.005, 0.6);
  if (rng() < explP) y += Math.abs(gauss(rng, 15, 12));
  y = Math.round(clamp(y, -4, 99));
  const oob = rng() < (off.oob || 0.14);
  return { yards: y, complete: true, outOfBounds: oob, clockStops: oob,
    desc: y >= 20 ? `Complete for ${y} — big gain.` : `Complete for ${y}.` };
}

// ---------------------------------------------------------------- Clock
function elapsedFor(state, outcome, tempo = 'normal') {
  const playTime = outcome.deadBall ? 0 : 5 + Math.round(Math.abs(outcome.yards) / 8);
  if (state.clockStopped) return playTime + 4;
  const pre = tempo === 'hurry' ? 14 : tempo === 'chew' ? 39 : 34;
  return playTime + pre;
}

// ---------------------------------------------------------------- State
export const XP_PROB = 0.94;
export const TWO_POINT_PROB = 0.485;

/**
 * The play after a touchdown. Kicking is nearly automatic; going for two is a
 * real coin flip, which is what makes the decision worth having.
 */
export function resolveConversion(state, choice, rng) {
  const s = JSON.parse(JSON.stringify(state));
  const events = [];
  const pc = s.pendingConversion;
  if (!pc) return { state: s, events, outcome: null };
  const key = pc.scoreKey;

  let outcome;
  if (choice === 'two') {
    const good = rng() < TWO_POINT_PROB;
    if (good) s.score[key] += 2;
    events.push({ type: good ? 'score' : 'miss',
      text: good ? 'Two point conversion is good.' : 'Two point try is no good.' });
    outcome = { desc: good ? 'Two point conversion is good.' : 'Two point try fails.',
      special: 'two', made: good, yards: 0 };
  } else {
    const good = rng() < XP_PROB;
    if (good) s.score[key] += 1;
    events.push({ type: good ? 'score' : 'miss',
      text: good ? 'Extra point is good.' : 'Extra point is missed.' });
    outcome = { desc: good ? 'Extra point is good.' : 'Extra point is no good.',
      special: 'xp', made: good, yards: 0 };
  }

  s.pendingConversion = null;
  s.playIndex += 1;
  s.clock = Math.max(0, s.clock - 4);
  // Kick off to the other side.
  s.possession = pc.team === 'US' ? 'CPU' : 'US';
  s.ballOn = 25;
  s.clockStopped = true;
  s.down = 1;
  s.distance = 10;
  s.driveIndex += 1;
  s.drivePlays = 0;
  s.driveStartYard = 25;
  s.lastPlay = outcome;
  return finishState(s, events, outcome);
}

/** Shared period handling, so a conversion rolls the clock like anything else. */
function finishState(s, events, outcome) {
  const r = finish(s, events, outcome, {});
  return { ...r, outcome };
}

/**
 * Should the CPU go for two? Uses the standard chart: the decision is about
 * which margin the extra point leaves you needing.
 */
export function cpuConversion(state, rng) {
  const pc = state.pendingConversion;
  if (!pc) return 'kick';
  const mine = pc.scoreKey;
  const theirs = mine === 'us' ? 'them' : 'us';
  const lead = state.score[mine] - state.score[theirs];
  const late = state.quarter >= 4 || (state.quarter === 3 && state.clock < 300);

  // Margins where two points changes what you need next.
  const GO = [-10, -5, -2, 1, 4, 5, 12, 19];
  if (late && GO.includes(lead)) return 'two';
  if (state.quarter >= 4 && state.clock < 120 && lead < 0) return 'two';
  return rng() < 0.04 ? 'two' : 'kick';
}

/**
 * Spend a timeout. Stops the clock, which is the whole point of having them.
 */
export function callTimeout(state, side) {
  const s = JSON.parse(JSON.stringify(state));
  const key = side === 'US' ? 'us' : 'them';
  if ((s.timeouts?.[key] || 0) <= 0) return { state, events: [], spent: false };
  s.timeouts[key] -= 1;
  s.clockStopped = true;
  return {
    state: s,
    events: [{ type: 'timeout', text: `Timeout${side === 'US' ? '' : ', defense'}.` }],
    spent: true,
  };
}

export function newGameState(cfg = {}) {
  return {
    quarter: 1,
    clock: 900,
    down: 1,
    distance: 10,
    ballOn: 25,            // yards from the possessing team's own goal line
    possession: cfg.firstPossession || 'CPU',
    secondHalfBall: cfg.firstPossession === 'US' ? 'CPU' : 'US',
    score: { us: 0, them: 0 },
    playIndex: 0,
    driveIndex: 0,
    driveStartYard: 25,
    drivePlays: 0,
    clockStopped: true,
    timeouts: { us: 3, them: 3 },
    pendingConversion: null,
    status: 'live',
    lastPlay: null,
  };
}

const other = (p) => (p === 'US' ? 'CPU' : 'US');

/** Apply an outcome to state. Returns { state, events[] }. Never mutates input. */
export function advance(prev, outcome, opts = {}) {
  const s = JSON.parse(JSON.stringify(prev));
  const events = [];
  const offenseIsUs = s.possession === 'US';
  const scoreKey = offenseIsUs ? 'us' : 'them';

  s.playIndex += 1;
  s.drivePlays += 1;
  const elapsed = elapsedFor(prev, outcome, opts.tempo);
  s.clock = Math.max(0, s.clock - elapsed);
  s.clockStopped = !!outcome.clockStops;

  const startBall = s.ballOn;

  if (outcome.penalty && outcome.penalty.replay) {
    s.ballOn = clamp(s.ballOn + outcome.penalty.yards, 1, 99);
    if (outcome.penalty.on === 'def') s.distance = Math.max(1, s.distance - outcome.penalty.yards);
    else s.distance = s.distance - outcome.penalty.yards;
    events.push({ type: 'penalty', text: outcome.desc });
    return finish(s, events, outcome, opts);
  }

  if (outcome.turnover) {
    const spot = clamp(s.ballOn + outcome.yards, 1, 99);
    const ret = outcome.returnYards || 0;
    s.possession = other(s.possession);
    s.ballOn = clamp(100 - spot - ret, 1, 99);
    if (100 - spot - ret <= 0) {
      // returned for a score
      const key = offenseIsUs ? 'them' : 'us';
      s.score[key] += 6;
      events.push({ type: 'score', text: `Returned all the way — touchdown.` });
      s.pendingConversion = { team: s.possession, scoreKey: key };
      s.clockStopped = true;
      return finish(s, events, outcome, opts);
    }
    events.push({ type: 'turnover', text: outcome.desc });
    return newDrive(s, events, outcome, opts);
  }

  s.ballOn = s.ballOn + outcome.yards;

  if (s.ballOn >= 100) {
    s.score[scoreKey] += 6;
    events.push({ type: 'score', text: 'Touchdown!' });
    // The conversion is a decision, not an assumption. Play stops here until
    // somebody chooses the kick or the two point try.
    s.pendingConversion = { team: s.possession, scoreKey };
    s.clockStopped = true;
    return finish(s, events, outcome, opts);
  }
  if (s.ballOn <= 0) {
    s.score[offenseIsUs ? 'them' : 'us'] += 2;
    events.push({ type: 'score', text: 'Safety.' });
    s.ballOn = 20;
    s.possession = other(s.possession);
    return newDrive(s, events, outcome, opts);
  }

  const gained = s.ballOn - startBall;
  if (outcome.firstDown || gained >= s.distance) {
    s.down = 1;
    s.distance = Math.min(10, 100 - s.ballOn);
    events.push({ type: 'firstDown', text: 'First down.' });
  } else {
    s.down += 1;
    s.distance = s.distance - gained;
    if (s.down > 4) {
      s.possession = other(s.possession);
      s.ballOn = clamp(100 - s.ballOn, 1, 99);
      events.push({ type: 'turnover', text: 'Turnover on downs.' });
      return newDrive(s, events, outcome, opts);
    }
  }

  return finish(s, events, outcome, opts);
}

function newDrive(s, events, outcome, opts) {
  s.down = 1;
  s.distance = Math.min(10, 100 - s.ballOn);
  s.driveIndex += 1;
  s.drivePlays = 0;
  s.driveStartYard = s.ballOn;
  return finish(s, events, outcome, opts);
}

function kickoff(s, events, receiving, outcome, opts) {
  s.possession = receiving;
  s.ballOn = 25;
  s.clockStopped = true;
  return newDrive(s, events, outcome, opts);
}

function finish(s, events, outcome, opts) {
  s.lastPlay = outcome;
  if (s.clock <= 0) {
    if (s.quarter === 2) {
      events.push({ type: 'period', text: 'End of the first half.' });
      s.quarter = 3; s.clock = 900; s.possession = s.secondHalfBall;
      s.ballOn = 25; s.down = 1; s.distance = 10; s.clockStopped = true;
      s.driveIndex += 1; s.drivePlays = 0; s.timeouts = { us: 3, them: 3 };
    } else if (s.quarter >= 4) {
      if (s.score.us === s.score.them && s.quarter === 4) {
        events.push({ type: 'period', text: 'Regulation ends tied. Overtime.' });
        s.quarter = 5; s.clock = 600; s.overtime = true;
      } else {
        s.status = 'final';
        events.push({ type: 'final', text: 'That is the ball game.' });
      }
    } else {
      events.push({ type: 'period', text: `End of the ${s.quarter === 1 ? 'first' : 'third'} quarter.` });
      s.quarter += 1; s.clock = 900;
    }
  }
  if (s.overtime && s.status !== 'final' && s.score.us !== s.score.them) {
    s.status = 'final';
    events.push({ type: 'final', text: 'Overtime winner.' });
  }
  return { state: s, events };
}

// ---------------------------------------------------------------- Special teams
export function fieldGoalProb(ballOn) {
  const dist = 100 - ballOn + 17;
  return clamp(1 / (1 + Math.exp((dist - 58) / 7)), 0.01, 0.985);
}

export function resolveSpecial(state, type, rng) {
  const s = JSON.parse(JSON.stringify(state));
  const events = [];
  const offenseIsUs = s.possession === 'US';
  const dist = 100 - s.ballOn + 17;

  if (type === 'fg') {
    const good = rng() < fieldGoalProb(s.ballOn);
    s.clock = Math.max(0, s.clock - 8);
    if (good) {
      s.score[offenseIsUs ? 'us' : 'them'] += 3;
      events.push({ type: 'score', text: `${dist}-yard field goal is good.` });
      const r = kickoff(s, events, other(s.possession), { desc: 'FG' }, {});
      r.state.playIndex += 1;
      return { ...r, outcome: { desc: `${dist}-yard field goal is good.`, special: 'fg', made: true, yards: 0, kickDist: dist } };
    }
    events.push({ type: 'miss', text: `${dist}-yard attempt is no good.` });
    s.possession = other(s.possession);
    s.ballOn = clamp(100 - Math.max(s.ballOn, 20), 1, 99);
    s.clockStopped = true;
    const r = newDrive(s, events, { desc: 'miss' }, {});
    r.state.playIndex += 1;
    return { ...r, outcome: { desc: `${dist}-yard attempt is no good.`, special: 'fg', made: false, yards: 0, kickDist: dist } };
  }

  if (type === 'punt') {
    const net = Math.round(clamp(gauss(rng, 41, 8), 20, 65));
    s.clock = Math.max(0, s.clock - 12);
    let landing = s.ballOn + net;
    if (landing >= 100) landing = 80; // touchback
    s.possession = other(s.possession);
    s.ballOn = clamp(100 - landing, 1, 99);
    s.clockStopped = true;
    events.push({ type: 'punt', text: `Punt nets ${net} yards.` });
    const r = newDrive(s, events, { desc: 'punt' }, {});
    r.state.playIndex += 1;
    return { ...r, outcome: { desc: `Punt nets ${net} yards.`, special: 'punt', yards: 0, net } };
  }

  if (type === 'kneel') {
    s.clock = Math.max(0, s.clock - 40);
    s.down += 1; s.distance += 2; s.ballOn = Math.max(1, s.ballOn - 2);
    s.clockStopped = false;
    events.push({ type: 'kneel', text: 'Quarterback kneels.' });
    const r = finish(s, events, { desc: 'Kneel down.' }, {});
    r.state.playIndex += 1;
    return { ...r, outcome: { desc: 'Kneel down.', special: 'kneel', yards: 0 } };
  }

  if (type === 'spike') {
    s.clock = Math.max(0, s.clock - 3);
    s.down += 1;
    s.clockStopped = true;
    events.push({ type: 'spike', text: 'Spiked to stop the clock.' });
    const r = finish(s, events, { desc: 'Spike.' }, {});
    r.state.playIndex += 1;
    return { ...r, outcome: { desc: 'Spike.', special: 'spike', yards: 0 } };
  }

  throw new Error(`unknown special ${type}`);
}

// ---------------------------------------------------------------- CPU brains
// Defense: score every call against the predicted family distribution, using
// the same edge math the resolver uses. Softmax keeps it beatable.
const REPS = {
  run: ['iz', 'power', 'oz'],
  quick: ['slants', 'stick'],
  screen: ['rbscreen'],
  dropback: ['mesh', 'flood', 'dagger'],
  playaction: ['paboot', 'padig'],
  shot: ['verts', 'pashot'],
};

export function scoreDefenses(state, tendencies) {
  const probs = readTendencies(tendencies, state);
  return DEFENSE.map((def) => {
    let expected = 0;
    for (const f of FAMILIES) {
      const reps = REPS[f];
      let e = 0;
      for (const id of reps) e += computeEdge(OFF_BY_ID[id], def, { tendencies });
      expected += probs[f] * (e / reps.length);
    }
    let score = -expected; // defense wants to minimise offensive edge
    score += situationalDefBias(def, state);
    return { def, score };
  });
}

function situationalDefBias(def, state) {
  let b = 0;
  const zone = fieldZone(state.ballOn);
  const twoMin = state.clock < 120 && (state.quarter === 2 || state.quarter >= 4);
  if (zone === 'redZone' && state.ballOn >= 95) b += def.id === 'goalline' ? 0.16 : 0;
  else if (def.id === 'goalline') b -= 0.6;
  if (def.id === 'prevent') b += twoMin && state.distance > 12 ? 0.14 : -0.5;
  if (def.pers === 'dime') b += state.down === 3 && state.distance >= 8 ? 0.07 : -0.12;
  if (def.pers === 'base') b += state.distance <= 3 ? 0.06 : -0.04;
  return b;
}

export function cpuDefensiveCall(state, tendencies, rng, temp = 0.105) {
  const scored = scoreDefenses(state, tendencies);
  return softmaxPick(scored.map((s) => ({ id: s.def.id, score: s.score })), rng, temp);
}

const FAMILY_SIZE = FAMILIES.reduce((acc, f) => {
  acc[f] = OFFENSE.filter((p) => p.family === f).length;
  return acc;
}, {});

export function cpuOffensiveCall(state, tendencies, rng, identity = {}) {
  // Deliberately reads the situational prior, NOT its own tendency history.
  // Feeding a play-caller its own past calls creates a runaway feedback loop
  // where one family drowns out the rest by the second quarter.
  const probs = priorFor(state);
  const lean = identity.runLean || 0;
  // Installed user concepts belong to that coordinator, not every CPU club in
  // the league. Keeping the opponent pool built-in also makes its advance film
  // stable and guarantees every scouted call has a diagram.
  const cands = OFFENSE.filter((off) => !off.custom).map((off) => {
    // Spread the family's probability across the plays inside it, otherwise
    // whichever family has the most plays gets picked far too often.
    let score = (probs[off.family] / FAMILY_SIZE[off.family]) * 9.0;
    if (off.family === 'run') score += lean * 0.12;
    score += identity.playLeans?.[off.id] || 0;
    // Situational sanity.
    if (state.distance <= 2 && off.id === 'sneak') score += 0.30;
    else if (off.id === 'sneak') score -= 2;
    if (state.distance >= 12 && (off.family === 'run' || off.family === 'quick')) score -= 0.10;
    if (state.ballOn >= 92 && (off.family === 'shot' || off.id === 'comebacks')) score -= 0.55;
    if (state.ballOn <= 8 && off.family === 'shot') score -= 0.20;
    const clock = state.clock < 100 && state.quarter >= 4;
    if (clock && off.family === 'run') score -= 0.22;
    return { id: off.id, score };
  });
  return softmaxPick(cands, rng, 0.28);
}

function softmaxPick(cands, rng, temp) {
  const max = Math.max(...cands.map((c) => c.score));
  const exps = cands.map((c) => Math.exp((c.score - max) / temp));
  const sum = exps.reduce((a, b) => a + b, 0);
  let r = rng() * sum;
  for (let i = 0; i < cands.length; i++) { r -= exps[i]; if (r <= 0) return cands[i].id; }
  return cands[cands.length - 1].id;
}

/** Fourth down logic for the CPU offense. Returns 'go' | 'fg' | 'punt'. */
export function cpuFourthDown(state, rng, forUs = false) {
  const toGo = state.distance;
  const fgP = fieldGoalProb(state.ballOn);
  // Positive means the side with the ball is behind.
  const trailing = forUs
    ? state.score.us - state.score.them
    : state.score.them - state.score.us;
  const desperate = state.quarter >= 4 && state.clock < 300 && trailing < 0;
  if (state.ballOn >= 62 && fgP > 0.62 && !(desperate && toGo <= 2 && state.ballOn >= 92)) {
    if (!(toGo <= 1 && state.ballOn >= 95)) return 'fg';
  }
  if (toGo <= 1 && state.ballOn >= 45) return 'go';
  if (desperate && (toGo <= 6 || state.clock < 120)) return 'go';
  if (state.ballOn >= 55 && toGo <= 3) return rng() < 0.55 ? 'go' : 'fg';
  return 'punt';
}
