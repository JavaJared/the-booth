// spatial.js — exact play-design geometry matched against the called defense.
//
// The original designer compiled drawings into aggregate football ratings.
// Those remain the stable baseline. This layer preserves the actual paths and
// adds a bounded design edge for where routes, zones, rushers and blocks meet.
import { FORMATIONS, runSpots, DEF_ALIGN, OL_SPOTS } from './designer.js';

const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const last = (points) => points?.[points.length - 1];
const FRONT = ['EDGE1', 'DT1', 'DT2', 'EDGE2'];
const MAN_ASSIGN = {
  WR1: 'CB1', WR2: 'CB2', WR3: 'NB', TE1: 'S1', TE2: 'LB1',
  RB1: 'LB2', RB2: 'LB2', QB: 'LB1',
};
const point = (p) => {
  const raw = Array.isArray(p) ? p : [p?.x, p?.y];
  const x = Number(raw[0]), y = Number(raw[1]);
  return [clamp(Number.isFinite(x) ? x : 26.6, -8, 61.3),
    clamp(Number.isFinite(y) ? y : 0, -10, 50)];
};

const clonePaths = (paths = {}) => Object.fromEntries(Object.entries(paths)
  .filter(([, points]) => Array.isArray(points) && points.length)
  .map(([spot, points]) => [spot, points.slice(0, 16).map(point)]));

/** Canonical geometry for built-in calls, or the preserved drawing for custom calls. */
export function offenseGeometry(play) {
  if (play?.geometry?.paths) return {
    ...play.geometry,
    spots: { ...(play.geometry.spots || {}) },
    paths: clonePaths(play.geometry.paths),
  };
  if (!play) return null;
  const pers = FORMATIONS[play.pers] ? play.pers : '11';
  const spots = play.family === 'run' ? runSpots(pers) : FORMATIONS[pers].spots;
  const start = (spot) => spots[spot] || FORMATIONS['11'].spots[spot] || [26.6, 0];
  const route = (spot, ...points) => [start(spot), ...points];
  const passes = {
    slants: { WR1: route('WR1', [16, 7]), WR2: route('WR2', [38, 7]), WR3: route('WR3', [28, 6]) },
    stick: { TE1: route('TE1', [35, 6], [39, 6]), WR3: route('WR3', [17, 5]), RB1: route('RB1', [20, 1]) },
    hitches: { WR1: route('WR1', [3, 7], [8, 6]), WR2: route('WR2', [50, 7], [45, 6]), WR3: route('WR3', [17, 6]) },
    spacing: { WR1: route('WR1', [10, 5]), WR2: route('WR2', [43, 5]), WR3: route('WR3', [22, 4]), TE1: route('TE1', [31, 4]) },
    rbscreen: { RB1: route('RB1', [20, -1], [14, 3], [8, 7]), WR1: route('WR1', [3, 9]), WR2: route('WR2', [50, 12]) },
    tunnel: { WR3: route('WR3', [21, 0], [25, 4]), WR1: route('WR1', [3, 12]), WR2: route('WR2', [50, 14]) },
    mesh: { WR1: route('WR1', [12, 5], [34, 5]), WR2: route('WR2', [41, 6], [18, 6]), WR3: route('WR3', [20, 12]), TE1: route('TE1', [35, 10]) },
    flood: { WR1: route('WR1', [4, 18]), TE1: route('TE1', [43, 10], [51, 12]), WR2: route('WR2', [50, 4]), RB1: route('RB1', [40, 1]) },
    dagger: { WR1: route('WR1', [3, 22]), WR2: route('WR2', [49, 18], [29, 18]), TE1: route('TE1', [35, 8]) },
    smash: { WR1: route('WR1', [3, 6]), WR2: route('WR2', [50, 6]), WR3: route('WR3', [17, 10], [8, 18]), TE1: route('TE1', [35, 10], [45, 18]) },
    ycross: { TE1: route('TE1', [31, 7], [15, 14]), WR1: route('WR1', [3, 20]), WR2: route('WR2', [42, 12]), WR3: route('WR3', [23, 5]) },
    curlflat: { WR1: route('WR1', [3, 11], [9, 9]), WR2: route('WR2', [50, 11], [44, 9]), RB1: route('RB1', [16, 1]), TE1: route('TE1', [35, 7]) },
    comebacks: { WR1: route('WR1', [3, 16], [9, 12]), WR2: route('WR2', [50, 16], [44, 12]), WR3: route('WR3', [17, 12], [22, 10]) },
    paboot: { TE1: route('TE1', [40, 7], [48, 11]), WR1: route('WR1', [3, 20]), WR2: route('WR2', [42, 13]), RB1: route('RB1', [34, 0]) },
    padig: { WR1: route('WR1', [3, 18], [24, 18]), WR2: route('WR2', [50, 20]), TE1: route('TE1', [35, 9]) },
    verts: { WR1: route('WR1', [3, 28]), WR2: route('WR2', [50, 28]), WR3: route('WR3', [18, 27]), TE1: route('TE1', [35, 27]) },
    postwheel: { WR1: route('WR1', [3, 15], [23, 27]), RB1: route('RB1', [37, 2], [48, 20]), WR2: route('WR2', [50, 25]) },
    pashot: { WR1: route('WR1', [3, 14], [24, 28]), WR2: route('WR2', [50, 27]), TE1: route('TE1', [35, 14]), RB1: route('RB1', [39, 1]) },
  };
  const runs = {
    iz: { RB1: route('RB1', [27, 2], [28, 9]) },
    oz: { RB1: route('RB1', [34, -1], [42, 4], [49, 10]) },
    power: { RB1: route('RB1', [25, -1], [22, 7]) },
    counter: { RB1: route('RB1', [31, -4], [22, 1], [18, 8]) },
    toss: { RB1: route('RB1', [38, -3], [48, 3], [51, 10]) },
    draw: { QB: [[26.6, 0], [26.6, 7]] },
    trap: { RB1: route('RB1', [27, 0], [31, 7]) },
    sneak: { QB: [[26.6, 0], [26.6, 3]] },
  };
  return {
    type: play.family === 'run' ? 'run' : 'pass', pers, spots,
    paths: clonePaths(passes[play.id] || runs[play.id] || {}),
    blockers: [], carrierSpot: play.family === 'run' ? Object.keys(runs[play.id] || {})[0] : null,
  };
}

export function defenseGeometry(call) {
  if (!call) return null;
  if (call.geometry?.paths) {
    const spots = { ...DEF_ALIGN, ...(call.geometry.spots || call.geometry.positions || {}) };
    const paths = clonePaths(call.geometry.paths);
    const rushers = Object.entries(paths).filter(([, points]) => last(points)?.[1] <= 0.8)
      .map(([spot]) => spot);
    for (const spot of FRONT) {
      if (!paths[spot] && spots[spot]?.[1] <= 1.5) rushers.push(spot);
    }
    const uniqueRushers = [...new Set(rushers)];
    const man = call.geometry.man ?? call.cov?.startsWith('man');
    const zones = man ? [] : Object.keys(spots).filter((spot) => !uniqueRushers.includes(spot));
    return { type: 'defense', spots, paths, rushers: uniqueRushers, zones, man };
  }

  const spots = { ...DEF_ALIGN }, paths = {};
  const path = (spot, end) => { paths[spot] = [spots[spot], end]; };
  const extras = call.id === 'nickblitz' ? ['NB', 'LB1', 'LB2']
    : call.id === 'agap' ? ['LB1', 'LB2', 'NB'] : ['LB1', 'NB', 'LB2'];
  const rushers = [...FRONT, ...extras].slice(0, call.rush);
  for (const spot of rushers) path(spot, [spots[spot][0], -3]);
  const drop = (spot, end) => { if (!rushers.includes(spot)) path(spot, end); };
  if (call.cov === 'man0' || call.cov === 'man1') {
    drop('CB1', [8, 11]); drop('CB2', [45, 11]); drop('NB', [17, 9]);
    drop('LB1', [22, 8]); drop('LB2', [32, 8]);
    if (call.cov === 'man1') { drop('S1', [26.6, 21]); drop('S2', [34, 9]); }
    else { drop('S1', [20, 8]); drop('S2', [34, 8]); }
  } else if (call.cov === 'cover2' || call.cov === 'tampa2') {
    drop('CB1', [8, 5]); drop('CB2', [45, 5]); drop('NB', [16, 8]);
    drop('LB1', call.cov === 'tampa2' ? [26.6, 16] : [22, 10]);
    drop('LB2', [34, 10]); drop('S1', [16, 20]); drop('S2', [38, 20]);
  } else if (call.cov === 'quarters') {
    drop('CB1', [7, 20]); drop('S1', [20, 20]); drop('S2', [34, 20]); drop('CB2', [47, 20]);
    drop('NB', [14, 8]); drop('LB1', [24, 9]); drop('LB2', [32, 9]);
  } else if (call.cov === 'cover6') {
    drop('CB1', [7, 20]); drop('S1', [20, 20]); drop('S2', [38, 20]); drop('CB2', [46, 6]);
    drop('NB', [14, 8]); drop('LB1', [24, 9]); drop('LB2', [34, 9]);
  } else {
    drop('CB1', [8, 19]); drop('S1', [26.6, 21]); drop('CB2', [45, 19]);
    drop('NB', [15, 8]); drop('LB1', [24, 10]); drop('LB2', [34, 10]); drop('S2', [39, 8]);
  }
  for (const [spot, start] of Object.entries(spots)) {
    if (!paths[spot]) path(spot, [start[0], Math.max(8, start[1])]);
  }
  const man = call.cov === 'man0' || call.cov === 'man1';
  return { type: 'defense', spots, paths, rushers,
    zones: man ? [] : Object.keys(paths).filter((spot) => !rushers.includes(spot)), man };
}

function samplePath(points, startShare = 0.45) {
  if (!points || points.length < 2) return [];
  const segments = [];
  let total = 0;
  for (let i = 1; i < points.length; i += 1) {
    const len = Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]);
    segments.push({ from: points[i - 1], to: points[i], len, at: total });
    total += len;
  }
  const samples = [];
  for (const seg of segments) {
    const steps = Math.max(2, Math.ceil(seg.len / 2));
    for (let i = 0; i <= steps; i += 1) {
      const distance = seg.at + seg.len * (i / steps);
      if (distance / (total || 1) < startShare) continue;
      samples.push([
        seg.from[0] + (seg.to[0] - seg.from[0]) * (i / steps),
        seg.from[1] + (seg.to[1] - seg.from[1]) * (i / steps),
      ]);
    }
  }
  return samples;
}

function pointAt(points, share) {
  if (!points?.length) return null;
  if (points.length === 1) return points[0];
  const lengths = points.slice(1).map((p, i) =>
    Math.hypot(p[0] - points[i][0], p[1] - points[i][1]));
  const total = lengths.reduce((a, b) => a + b, 0) || 1;
  let wanted = total * share;
  for (let i = 0; i < lengths.length; i += 1) {
    if (wanted <= lengths[i]) {
      const t = wanted / (lengths[i] || 1);
      return [points[i][0] + (points[i + 1][0] - points[i][0]) * t,
        points[i][1] + (points[i + 1][1] - points[i][1]) * t];
    }
    wanted -= lengths[i];
  }
  return last(points);
}

const zoneAt = (geometry, spot) => {
  const point = last(geometry.paths[spot]) || geometry.spots[spot];
  const deep = point[1] >= 15;
  return { point, rx: deep ? 7.2 : 5.3, ry: deep ? 5.5 : 4.0 };
};

function protectionEdge(offense, defense) {
  const extraRushers = defense.rushers.filter((spot) => !FRONT.includes(spot));
  const blockers = offense.blockers || [];
  let edge = 0;
  for (const rusher of extraRushers) {
    const x = defense.spots[rusher]?.[0] ?? 26.6;
    const handled = blockers.some((spot) => Math.abs((offense.spots[spot]?.[0] ?? 26.6) - x) <= 10);
    edge += handled ? 0.012 : -0.022;
  }
  return edge;
}

function manSpatial(off, offense, defense) {
  const reads = {};
  for (const [spot, route] of Object.entries(offense.paths)) {
    if (spot in OL_SPOTS || route.length < 2) continue;
    const defender = MAN_ASSIGN[spot];
    const track = defense.paths[defender] || [defense.spots[defender]];
    let separation = 0;
    for (const share of [0.5, 0.65, 0.8, 0.92, 1]) {
      const receiverAt = pointAt(route, share), defenderAt = pointAt(track, share);
      if (receiverAt && defenderAt) separation = Math.max(separation,
        Math.hypot(receiverAt[0] - defenderAt[0], receiverAt[1] - defenderAt[1]));
    }
    reads[spot] = clamp((separation - 4) / 9, -1, 1);
  }
  const bestReads = Object.values(reads).sort((a, b) => b - a).slice(0, 2);
  const space = bestReads.length ? bestReads.reduce((a, b) => a + b, 0) / bestReads.length : 0;
  const targetWeights = Object.fromEntries(Object.entries(off.targets || {}).map(([spot, weight]) =>
    [spot, Math.max(1, Math.round(weight * clamp(1 + (reads[spot] || 0) * 0.65, 0.35, 1.7)))]));
  const pressure = protectionEdge(offense, defense);
  return { edge: clamp((space - 0.1) * 0.06 + pressure, -0.09, 0.09),
    pressure, targetWeights, reads };
}

function passSpatial(off, def, offense, defense) {
  if (!Object.keys(offense.paths).length) {
    return { edge: 0, pressure: 0, targetWeights: off.targets || {}, reads: {} };
  }
  if (defense.man) return manSpatial(off, offense, defense);
  if (!defense.zones.length) return {
    edge: 0, pressure: 0, targetWeights: off.targets || {}, reads: {},
  };
  const zones = defense.zones.map((spot) => zoneAt(defense, spot));
  const reads = {};
  for (const [spot, route] of Object.entries(offense.paths)) {
    if (spot in OL_SPOTS || route.length < 2) continue;
    const windows = samplePath(route).filter((p) => p[1] >= 2.5);
    let best = -1;
    for (const point of windows) {
      const nearest = Math.min(...zones.map((z) => Math.hypot(
        (point[0] - z.point[0]) / z.rx, (point[1] - z.point[1]) / z.ry)));
      best = Math.max(best, clamp((nearest - 0.9) / 0.9, -1, 1));
    }
    reads[spot] = best;
  }
  const bestReads = Object.values(reads).sort((a, b) => b - a).slice(0, 2);
  const space = bestReads.length ? bestReads.reduce((a, b) => a + b, 0) / bestReads.length : 0;

  const targetWeights = Object.fromEntries(Object.entries(off.targets || {}).map(([spot, weight]) =>
    [spot, Math.max(1, Math.round(weight * clamp(1 + (reads[spot] || 0) * 0.72, 0.3, 1.75)))]));
  const pressure = protectionEdge(offense, defense);
  return {
    edge: clamp((space - 0.08) * 0.075 + pressure, -0.09, 0.09), pressure,
    targetWeights,
    reads,
  };
}

function runSpatial(off, offense, defense) {
  if (!off.custom) return { edge: 0, pressure: 0, targetWeights: off.targets || {}, reads: {} };
  const carrier = offense.paths[offense.carrierSpot] || Object.values(offense.paths)[0];
  if (!carrier?.length) return { edge: 0, pressure: 0, targetWeights: off.targets || {}, reads: {} };
  const aim = carrier.find((p) => p[1] >= 1) || last(carrier);
  const threats = Object.entries(defense.spots).filter(([spot, point]) =>
    !defense.rushers.includes(spot) && point[1] <= 7 && Math.abs(point[0] - aim[0]) <= 6)
    .map(([spot]) => spot);
  const blockEnds = Object.entries(offense.paths).filter(([spot]) => spot in OL_SPOTS)
    .map(([, points]) => last(points));
  const sealed = threats.filter((spot) => blockEnds.some((point) =>
    Math.hypot(point[0] - defense.spots[spot][0], point[1] - defense.spots[spot][1]) <= 5)).length;
  const lane = sealed - Math.max(0, threats.length - sealed) * 0.65;
  return { edge: clamp(lane * 0.025, -0.08, 0.08), pressure: 0,
    targetWeights: off.targets || {}, reads: {} };
}

/** Exact geometry bonus. Aggregate shell/family ratings remain the baseline;
    this bounded edge is the reward for solving the particular drawing. */
export function spatialMatchup(off, def) {
  if (!off || !def || (!off.custom && !def.custom)) {
    return { edge: 0, pressure: 0, targetWeights: off?.targets || {}, reads: {} };
  }
  const offense = offenseGeometry(off), defense = defenseGeometry(def);
  if (!offense || !defense) return {
    edge: 0, pressure: 0, targetWeights: off.targets || {}, reads: {},
  };
  return off.family === 'run' ? runSpatial(off, offense, defense)
    : passSpatial(off, def, offense, defense);
}
