// designer.js — turning a drawing into a football concept.
//
// The point of this file: a coordinator does not get to declare that their play
// beats man coverage. They draw routes, and the geometry decides. Two crossers
// meeting underneath IS a mesh whether or not you call it one; three routes
// stacked at different depths down one sideline IS a flood. That keeps custom
// plays honest, because you cannot label your way to an advantage.
//
// Field frame: x runs 0 (left sideline) to 53.3 (right), the line of scrimmage
// is y = 0, and downfield is +y.

export const FIELD_W = 53.3;
export const HASH_L = 23.6;
export const HASH_R = 29.7;

/** Where each eligible lines up, by personnel grouping. */
export const FORMATIONS = {
  '11': { label: '3 WR, 1 TE, 1 RB',
    spots: { WR1: [3, 0], WR2: [50, 0], WR3: [17, 1], TE1: [35, 0], RB1: [24, -5] } },
  '12': { label: '2 WR, 2 TE, 1 RB',
    spots: { WR1: [4, 0], WR2: [49, 0], TE1: [34, 0], TE2: [19, 0], RB1: [26, -5] } },
  '10': { label: '4 WR, 1 RB',
    spots: { WR1: [3, 0], WR2: [50, 0], WR3: [15, 1], TE1: [38, 1], RB1: [26, -5] } },
  '21': { label: '2 WR, 1 TE, 2 RB',
    spots: { WR1: [4, 0], WR2: [49, 0], TE1: [34, 0], RB1: [24, -5], RB2: [29, -3] } },
};

const last = (a) => a[a.length - 1];
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

/* ---------------------------------------------------------------- routes */

/**
 * Describe a single drawn route. `points` is the polyline from the alignment
 * spot outward, in field coordinates.
 */
export function describeRoute(spot, points) {
  if (!points || points.length < 2) return null;
  const start = points[0];
  const end = last(points);
  const depth = Math.max(...points.map((p) => p[1]));
  const width = end[0] - start[0];

  // The final segment is what a defender actually has to cover.
  const tail = [points[points.length - 2], end];
  const dx = tail[1][0] - tail[0][0];
  const dy = tail[1][1] - tail[0][1];
  const angle = Math.atan2(dy, dx) * 180 / Math.PI;   // 90 = straight upfield

  // Which way is inside depends on which side of the ball you started.
  const inward = start[0] < FIELD_W / 2 ? 1 : -1;
  const breaksIn = dx * inward > 1.5;
  const breaksOut = dx * inward < -1.5;
  const vertical = Math.abs(dy) > Math.abs(dx) * 1.4 && dy > 0;

  return {
    spot, points, depth, width, angle,
    band: depth >= 17 ? 'deep' : depth >= 9 ? 'intermediate' : depth >= 3.5 ? 'quick' : 'flat',
    breaksIn, breaksOut, vertical,
    comeback: dy < -1.5,
    side: start[0] < FIELD_W / 2 ? 'L' : 'R',
    startX: start[0], endX: end[0], endY: end[1],
    length: points.slice(1).reduce((a, p, i) => a + dist(points[i], p), 0),
  };
}

/* --------------------------------------------------------------- concepts */

/**
 * Structural facts about the whole play. Everything downstream reads these
 * rather than the drawing, so the rules stay legible.
 */
export function readConcept(routes, opts = {}) {
  const live = routes.filter(Boolean);
  const byBand = (b) => live.filter((r) => r.band === b);
  const deep = byBand('deep'), inter = byBand('intermediate');
  const quick = byBand('quick'), flat = byBand('flat');

  // Crossers: two receivers running at each other underneath. This is the
  // structure that makes man coverage miserable and zone easy.
  // Two receivers cross when they swap sides of each other. Comparing their
  // endpoints was wrong: a genuine crosser finishes on the far side, which the
  // old test read as "they never met".
  let crossers = 0, rubs = 0;
  for (let i = 0; i < live.length; i++) {
    for (let j = i + 1; j < live.length; j++) {
      const a = live[i], b = live[j];
      const startGap = a.startX - b.startX;
      const endGap = a.endX - b.endX;
      const swapped = startGap * endGap < 0;
      const sameLevel = Math.abs(a.depth - b.depth) <= 5;
      if (swapped && sameLevel && Math.max(a.depth, b.depth) <= 14) crossers++;

      // A rub: two receivers starting close together whose paths pinch. Man
      // defenders run into each other; zone defenders simply pass them off.
      if (Math.abs(startGap) < 9 && Math.abs(endGap) < Math.abs(startGap) - 2
          && Math.max(a.depth, b.depth) <= 12) rubs++;
    }
  }

  // Shallow in-breaking routes separate against man without needing to cross.
  const shallowIn = live.filter((r) => r.breaksIn && r.depth <= 10).length;

  // Vertical stretch: routes down one side occupying separate depth bands,
  // which is what puts a zone defender in a bind he cannot solve.
  const stretchOn = (side) => {
    const bands = new Set(live
      .filter((r) => (r.endX < FIELD_W / 2 ? 'L' : 'R') === side)
      .map((r) => r.band));
    return bands.size;
  };
  const verticalStretch = Math.max(stretchOn('L'), stretchOn('R'));

  // Horizontal stretch: three or more at a similar depth spread wide.
  const spread = live.length
    ? Math.max(...live.map((r) => r.endX)) - Math.min(...live.map((r) => r.endX)) : 0;
  const levelCount = Math.max(
    live.filter((r) => Math.abs(r.depth - 6) < 4).length,
    live.filter((r) => Math.abs(r.depth - 13) < 5).length);
  const horizontalStretch = levelCount >= 3 && spread > 22;

  // High-low: a defender asked to cover two routes at different depths in the
  // same area. The bread and butter of zone beating.
  let highLow = 0;
  for (const a of [...inter, ...deep]) {
    for (const b of [...flat, ...quick]) {
      if (a.side === b.side && Math.abs(a.endX - b.endX) < 14) { highLow++; break; }
    }
  }

  const seams = deep.filter((r) => r.endX > 13 && r.endX < 40).length;
  const corners = deep.concat(inter).filter((r) => r.breaksOut && r.depth >= 12).length;
  const digs = deep.concat(inter).filter((r) => r.breaksIn && r.depth >= 12).length;

  const depths = live.map((r) => r.depth);
  const meanDepth = depths.length ? depths.reduce((a, b) => a + b, 0) / depths.length : 0;
  const maxDepth = depths.length ? Math.max(...depths) : 0;

  return {
    count: live.length,
    deep: deep.length, inter: inter.length, quick: quick.length, flat: flat.length,
    crossers, rubs, shallowIn, verticalStretch, horizontalStretch, highLow, seams, corners, digs,
    meanDepth, maxDepth, spread,
    blockers: opts.blockers || 0,
    playAction: !!opts.playAction,
  };
}

/* ------------------------------------------------------- concept to stats */

const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const compactPath = (points = [], limit = 16) => {
  const point = (p) => ({ x: +(p.x ?? p[0]), y: +(p.y ?? p[1]) });
  if (points.length <= limit) return points.map(point);
  return Array.from({ length: limit }, (_, i) => {
    const index = Math.round(i * (points.length - 1) / (limit - 1));
    return point(points[index]);
  });
};

/**
 * Convert structure into the same numbers a hand-authored concept carries, so
 * a drawn play runs through the identical resolver as everything else.
 */
export function derivePlay(design) {
  const routes = Object.entries(design.assignments || {})
    .map(([spot, pts]) => describeRoute(spot, pts))
    .filter(Boolean);
  const c = readConcept(routes, {
    blockers: design.blockers || 0,
    playAction: design.playAction,
  });

  // Depth drives the basic trade: deeper throws complete less and gain more.
  const d = c.meanDepth;
  const comp = clamp(0.82 - d * 0.019, 0.34, 0.86);
  const mean = clamp(3.4 + d * 0.63 + c.deep * 0.6, 3.5, 26);
  const sd = clamp(2.4 + d * 0.30, 2.6, 11);
  const expl = clamp(0.012 + c.maxDepth * 0.0085 + c.deep * 0.012, 0.015, 0.36);

  // Time to throw comes out of route depth; protection out of who stayed in.
  const timeCost = clamp((d - 4) * 0.006, -0.01, 0.075);
  const sack = clamp(0.030 + timeCost - c.blockers * 0.010 - (c.quick + c.flat) * 0.003, 0.012, 0.13);
  const int = clamp(0.012 + d * 0.0017 + c.deep * 0.004 - c.crossers * 0.002, 0.008, 0.07);

  // Coverage matchups, each one traceable to a structural fact.
  const vs = { man0: 0, man1: 0, cover2: 0, tampa2: 0, cover3: 0, quarters: 0, cover6: 0 };
  const add = (keys, v) => keys.forEach((k) => { vs[k] += v; });

  // Crossing, rubs and shallow in-breakers all punish man and do little to zone.
  const manWork = c.crossers * 0.055 + c.rubs * 0.028 + c.shallowIn * 0.014;
  add(['man0', 'man1'], manWork);
  // A concept built to lose defenders in traffic gives zone almost nothing:
  // zone defenders pass receivers off instead of chasing them.
  add(['cover2', 'tampa2', 'cover3', 'quarters', 'cover6'], -manWork * 0.55);

  // Zone beaters: stretching defenders vertically and horizontally.
  // Kept deliberately small. Stretching a zone is a general advantage, but the
  // real separation between concepts lives in the shell-specific terms below —
  // a blanket bonus made every drawn play look like it beat all five shells.
  const zoneWork = (c.verticalStretch - 1) * 0.018 + (c.horizontalStretch ? 0.020 : 0)
                 + Math.min(c.highLow, 3) * 0.010;
  add(['cover2', 'tampa2', 'cover3', 'quarters', 'cover6'], zoneWork);
  add(['man0', 'man1'], -zoneWork * 0.45);

  // Specific shells have specific holes.
  vs.cover3 += c.seams * 0.032 - c.corners * 0.012;   // seams open, but a corner
                                                      // route runs at the deep third
  vs.tampa2 -= c.seams * 0.026;                       // the mike runs the seam
  vs.cover2 += c.corners * 0.038;                     // corner over the flat defender
  vs.quarters -= c.deep * 0.020;                      // two safeties cap the deep
  vs.cover6 += (c.corners * 0.018 + c.seams * 0.012);
  vs.cover2 -= c.digs * 0.008;
  vs.cover3 += c.digs * 0.020;                        // dig behind the hook
  add(['man0', 'man1'], (c.digs + c.corners) * 0.010);

  for (const k of Object.keys(vs)) vs[k] = +clamp(vs[k], -0.16, 0.16).toFixed(3);

  // Quick throws and screens punish extra rushers; slow-developing shots pay.
  const blitzFit = +clamp(
    0.9 - d * 0.075 + c.blockers * 0.22 + (c.flat + c.quick) * 0.08, -0.6, 1.5).toFixed(2);

  const family = c.maxDepth >= 20 && c.deep >= 2 ? 'shot'
    : design.playAction ? 'playaction'
    : d <= 6 ? 'quick' : 'dropback';

  // Targets follow the routes: who is open more often gets thrown to more.
  const weights = {};
  for (const r of routes) {
    const openness = r.band === 'flat' ? 14 : r.band === 'quick' ? 22
      : r.band === 'intermediate' ? 26 : 18;
    weights[r.spot] = Math.round(openness + (r.crossers ? 6 : 0));
  }

  return {
    id: design.id,
    name: design.name || 'Untitled',
    family,
    pers: design.pers || '11',
    tag: describeTag(c),
    custom: true,
    comp: +comp.toFixed(3), mean: +mean.toFixed(2), sd: +sd.toFixed(2),
    sack: +sack.toFixed(4), int: +int.toFixed(4), expl: +expl.toFixed(3),
    vs, blitzFit,
    targets: weights,
    ...(design.playAction ? { paBonus: 1.0 } : {}),
    geometry: {
      type: 'pass',
      spots: { ...(FORMATIONS[design.pers]?.spots || FORMATIONS['11'].spots) },
      paths: Object.fromEntries(Object.entries(design.assignments || {})
        .map(([spot, points]) => [spot, compactPath(points)])),
      blockers: [...(design.blockerSpots || [])],
    },
    structure: c,
  };
}

/** A short human read on what was actually drawn. */
function describeTag(c) {
  const bits = [];
  if (c.crossers >= 1) bits.push('man beater');
  else if (c.rubs >= 1 || c.shallowIn >= 3) bits.push('beats man');
  if (c.horizontalStretch && c.verticalStretch >= 3) bits.push('flood');
  else if (c.verticalStretch >= 3) bits.push('vertical stretch');
  if (c.seams >= 2) bits.push('seams');
  if (c.corners >= 1 && !bits.includes('flood')) bits.push('corner');
  if (!bits.length) bits.push(c.meanDepth <= 6 ? 'quick game' : 'dropback');
  return bits.slice(0, 2).join(', ');
}

/* --------------------------------------------------------------- legality */

/** Reasons a drawing would not survive a rules check or a protection call. */
export function validate(design) {
  const problems = [];
  const spots = Object.keys(design.assignments || {});
  const routed = spots.filter((s) => (design.assignments[s] || []).length >= 2);
  if (routed.length < 2) problems.push('At least two receivers need a route.');
  if (routed.length > 5) problems.push('Only five eligible receivers can release.');
  for (const s of routed) {
    const r = describeRoute(s, design.assignments[s]);
    if (r && r.depth > 45) problems.push(`${s} runs off the top of the field.`);
    if (r && (r.endX < -1 || r.endX > FIELD_W + 1)) problems.push(`${s} runs out of bounds.`);
  }
  if (!design.name || !design.name.trim()) problems.push('Give the play a name.');
  return problems;
}

/* ================================================================= RUNS
   A run is drawn as the carrier's path plus where each lineman goes. The
   aiming point decides whether it attacks inside or the edge; pullers and
   double teams decide whether it beats a loaded box or needs a light one. */

export const OL_SPOTS = { LT: [18, 0], LG: [22, 0], C: [26.6, 0], RG: [31, 0], RT: [35, 0] };

/** Run alignments keep the skill players off the linemen — merging the two
 *  naively put the tight end on top of the right tackle. */
export const RUN_SPOTS = {
  '11': { WR1: [3, 0], WR2: [50, 0], WR3: [11, 1], TE1: [39, 0], RB1: [26.6, -5] },
  '12': { WR1: [4, 0], WR2: [49, 0], TE1: [39, 0], TE2: [14, 0], RB1: [26.6, -5] },
  '10': { WR1: [3, 0], WR2: [50, 0], WR3: [11, 1], TE1: [42, 1], RB1: [26.6, -5] },
  '21': { WR1: [4, 0], WR2: [49, 0], TE1: [39, 0], RB1: [26.6, -6], RB2: [31, -3] },
};
export const runSpots = (pers) => ({ ...(RUN_SPOTS[pers] || RUN_SPOTS['11']), ...OL_SPOTS });
const CENTER = 26.6;

export function readRun(design) {
  const path = design.carrier || [];
  const blocks = design.blocks || {};
  if (path.length < 2) return null;

  // Where the carrier crosses the line is the aiming point.
  let aim = path[path.length - 1];
  for (let i = 1; i < path.length; i++) {
    if (path[i][1] >= 0 && path[i - 1][1] < 0) { aim = path[i]; break; }
    if (path[i][1] >= 0.5) { aim = path[i]; break; }
  }
  const gap = aim[0] - CENTER;
  const start = path[0];

  // Moving away from the aiming point first is misdirection — counter, and the
  // reason a counter hurts a defence that flows hard.
  const firstMove = (path[1][0] - start[0]);
  const misdirection = Math.sign(firstMove) !== Math.sign(gap) && Math.abs(firstMove) > 1.5 ? 1 : 0;

  let pullers = 0, downBlocks = 0, doubles = 0, reach = 0;
  const targets = [];
  for (const [spot, pts] of Object.entries(blocks)) {
    if (!pts || pts.length < 2) continue;
    // Only linemen count toward the scheme read. A receiver blocking on the
    // perimeter is not a pulling guard, however far he travels.
    if (!(spot in OL_SPOTS)) continue;
    const from = OL_SPOTS[spot];
    const to = pts[pts.length - 1];
    const lateral = to[0] - from[0];
    targets.push(to);
    if (Math.abs(lateral) > 5.5) pullers++;
    else if (Math.abs(lateral) > 1.2) {
      if (Math.sign(lateral) === Math.sign(gap || 1)) reach++; else downBlocks++;
    }
  }
  for (let i = 0; i < targets.length; i++) {
    for (let j = i + 1; j < targets.length; j++) {
      if (Math.hypot(targets[i][0] - targets[j][0], targets[i][1] - targets[j][1]) < 2.2) doubles++;
    }
  }

  const depth = Math.min(...path.map((p) => p[1]));   // how deep he starts
  return {
    aimX: aim[0], gap, edge: Math.abs(gap) > 8.5 ? 'outside' : 'inside',
    misdirection, pullers, downBlocks, doubles, reach,
    blockers: Object.values(blocks).filter((b) => b && b.length > 1).length,
    depth,
  };
}

export function deriveRun(design) {
  const r = readRun(design);
  if (!r) return null;
  const outside = r.edge === 'outside';

  // Double teams move people; pulls take time. Both are real trades.
  const success = clamp(0.52 + r.doubles * 0.020 + r.downBlocks * 0.012
    - r.pullers * 0.012 - (outside ? 0.03 : 0), 0.38, 0.64);
  const mean = clamp(4.9 + r.doubles * 0.20 + (outside ? 0.55 : 0)
    + r.misdirection * 0.55 - r.pullers * 0.08, 3.6, 6.6);
  const sd = clamp(3.1 + (outside ? 1.3 : 0) + r.misdirection * 0.8 + r.pullers * 0.25, 2.6, 5.6);
  const stuff = clamp(0.14 + r.pullers * 0.018 + (outside ? 0.045 : 0)
    - r.doubles * 0.015 - r.downBlocks * 0.008, 0.07, 0.26);

  // Sensitivity to a loaded box. Misdirection and pulls beat a defence that is
  // counting bodies; straight-ahead power needs the numbers to be even.
  // Misdirection is what beats a loaded box. A puller on its own does not —
  // power still needs to win the numbers, it just wins them at one point.
  const boxFit = clamp(1.05 - r.misdirection * 0.30 - r.pullers * 0.05
    + r.doubles * 0.10 + r.downBlocks * 0.08 - (outside ? 0.25 : 0), 0.4, 1.5);

  const tag = [
    r.misdirection ? 'misdirection' : null,
    r.pullers >= 2 ? 'double pull' : r.pullers === 1 ? 'pull' : null,
    r.doubles >= 2 ? 'double teams' : null,
    outside ? 'perimeter' : null,
  ].filter(Boolean).slice(0, 2).join(', ') || 'downhill';

  return {
    id: design.id, name: design.name || 'Untitled', family: 'run',
    pers: design.pers || '11', tag, custom: true,
    success: +success.toFixed(3), mean: +mean.toFixed(2), sd: +sd.toFixed(2),
    stuff: +stuff.toFixed(3), fumble: 0.008,
    edge: r.edge, boxFit: +boxFit.toFixed(2),
    targets: design.carrierSpot === 'QB' ? { QB: 10 } : { RB1: 7, RB2: 3 },
    geometry: {
      type: 'run',
      spots: runSpots(design.pers || '11'),
      paths: {
        ...Object.fromEntries(Object.entries(design.blocks || {})
          .map(([spot, points]) => [spot, compactPath(points)])),
        [design.carrierSpot || 'RB1']: compactPath(design.carrier),
      },
      blockers: Object.keys(design.blocks || {}),
      carrierSpot: design.carrierSpot || 'RB1',
    },
    structure: r,
  };
}

/* ============================================================= DEFENSE
   A defensive call is drawn by placing defenders and marking who rushes.
   The coverage names itself from how many are deep and whether the backs are
   playing man or zone — which is how coverages are actually named. */

export const DEF_ALIGN = {
  EDGE1: [17, 1], DT1: [23, 1], DT2: [30, 1], EDGE2: [36, 1],
  LB1: [23, 6], LB2: [31, 6],
  CB1: [5, 6], CB2: [48, 6], NB: [14, 5],
  S1: [20, 13], S2: [34, 13],
};
const FRONT = ['EDGE1', 'EDGE2', 'DT1', 'DT2'];

export function readDefense(design) {
  const pos = { ...DEF_ALIGN, ...(design.positions || {}) };
  const paths = design.paths || {};
  const man = !!design.man;

  // A defender's job comes from what he was drawn doing. A path that crosses
  // the line is a blitz; one that ends behind it is a zone drop, and how deep
  // he lands is what actually decides the coverage — not where he stood.
  const rushers = new Set();
  const drops = {};
  for (const [spot, pts] of Object.entries(paths)) {
    if (!pts || pts.length < 2) continue;
    const end = pts[pts.length - 1];
    if (end[1] <= 0.8) rushers.add(spot);
    else drops[spot] = end;
  }
  // Anyone without a drawn assignment rushes if he is on the line.
  for (const [spot, p] of Object.entries(pos)) {
    if (paths[spot]?.length >= 2) continue;
    if (p[1] <= 1.5 && FRONT.includes(spot)) rushers.add(spot);
  }

  const landing = (spot) => drops[spot] || pos[spot];
  // Twelve yards, not ten: linebackers drop to ten in an ordinary Cover 2, and
  // counting those as deep turned every two-deep shell into quarters.
  const deep = Object.keys(pos).filter((k) => !rushers.has(k) && landing(k)[1] >= 12).length;
  // The box is who lines up near the ball or attacks it, not where a rusher
  // finishes — a linebacker at six yards is in the box.
  const inTheBox = Object.keys(pos).filter((k) => {
    const start = pos[k], end = landing(k);
    return Math.min(start[1], end[1]) <= 7 && start[0] >= 14 && start[0] <= 40;
  }).length;
  const press = ['CB1', 'CB2', 'NB'].filter((k) => pos[k] && pos[k][1] <= 3).length;
  // A linebacker carrying the deep middle is the Tampa wrinkle. Ordinary zone
  // drops reach nine or ten yards, so the bar has to be genuinely deep.
  const deepLB = ['LB1', 'LB2'].filter((k) => {
    if (rushers.has(k)) return false;
    const l = landing(k);
    return l[1] >= 13 && l[0] > 17 && l[0] < 37;
  }).length;

  // Coverages are named for how many defenders end up deep: two deep is Cover
  // 2, three is Cover 3, four is quarters. That is the actual convention, and
  // it falls straight out of where the drops finish.
  const deepBacks = deep - deepLB;
  let cov;
  if (man) cov = deep === 0 ? 'man0' : 'man1';
  else if (deepBacks >= 4) cov = 'quarters';
  else if (deepBacks === 2 && deepLB >= 1) cov = 'tampa2';
  else if (deepBacks === 3) cov = 'cover3';
  else if (deepBacks === 2) cov = 'cover2';
  else cov = 'cover3';

  return { cov, deep, deepLB, box: inTheBox, rush: rushers.size, press, man,
    rushers: [...rushers], drops: Object.keys(drops).length };
}

export function deriveDefense(design) {
  const d = readDefense(design);
  const runCommit = clamp((d.box - 6) * 0.14 + (d.rush - 4) * 0.06
    + d.press * 0.04 - (d.deep >= 2 ? 0.12 : 0), -0.4, 0.5);

  const pers = d.deep >= 2 && d.box <= 5 ? 'dime' : d.box >= 8 ? 'base' : 'nickel';
  const tag = [
    d.rush >= 6 ? 'all out' : d.rush === 5 ? 'five man pressure' : null,
    d.man ? 'man' : d.deep >= 2 ? 'two deep' : 'single high',
    d.box >= 8 ? 'loaded box' : d.box <= 5 ? 'light box' : null,
  ].filter(Boolean).slice(0, 2).join(', ');

  return {
    id: design.id, name: design.name || 'Untitled', custom: true,
    cov: d.cov, box: clamp(d.box, 4, 9), rush: clamp(d.rush, 3, 7),
    runCommit: +runCommit.toFixed(2), pers, tag,
    geometry: {
      type: 'defense',
      spots: { ...DEF_ALIGN, ...(design.positions || {}) },
      paths: Object.fromEntries(Object.entries(design.paths || {})
        .map(([spot, points]) => [spot, compactPath(points)])),
      man: !!design.man,
    },
    structure: d,
  };
}
