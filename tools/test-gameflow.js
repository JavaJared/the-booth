import assert from 'node:assert/strict';
import { computeEdge, resolveSnap, newGameState, emptyTendencies } from '../public/shared/engine.js';
import { runToNextDecision } from '../public/shared/gameflow.js';
import {
  OFFENSE, DEFENSE, OFF_BY_ID, DEF_BY_ID, registerCustomPlays,
  registerSeasonCalls, seasonCallIds,
} from '../public/shared/playbook.js';
import { derivePlay, deriveDefense } from '../public/shared/designer.js';
import { spatialMatchup } from '../public/shared/spatial.js';
import {
  createSeason,
  dehydrate,
  hydrate,
  finishedGameRecorded,
  recordGameFilm,
  simRemainingWeek,
  startOffseason,
  unlockFilmOverlay,
} from '../public/shared/season.js';
import { TEAMS } from '../public/shared/league.js';
import { DEF_SPOTS } from '../public/shared/roster.js';
import { depthChart } from '../public/shared/depth.js';
import {
  FILM_OVERLAY_COST, filmRows, opponentDiagram, opponentDefenseDiagram,
} from '../public/shared/film.js';

function gameAtCpuGoalLine() {
  return {
    state: {
      ...newGameState({ firstPossession: 'CPU' }),
      ballOn: 99,
      clockStopped: false,
    },
    tendencies: { US: emptyTendencies(), CPU: emptyTendencies() },
    filmPoints: { OC: 0, DC: 0 },
    pending: {},
    autoSeat: 'OC',
    gameplan: { OC: { tempo: 'normal' }, DC: {} },
  };
}

// Find a deterministic seed where the CPU scores from the one. The important
// regression is that the same server turn also resolves its conversion rather
// than returning the kick/two-point choice to the defensive coordinator.
let touchdownResult = null;
for (let i = 0; i < 100; i += 1) {
  const result = runToNextDecision(
    `cpu-touchdown-${i}`, gameAtCpuGoalLine(), { callId: 'base3' });
  if (result.plays.some((play) => play.conversion)) {
    touchdownResult = result;
    break;
  }
}

assert.ok(touchdownResult, 'expected a deterministic CPU touchdown seed');
assert.equal(touchdownResult.state.pendingConversion, null,
  'CPU conversion must not be returned as a human decision');
assert.ok(touchdownResult.plays.some((play) => ['kick', 'two'].includes(play.conversion)),
  'CPU should choose and resolve its own conversion');

// A Netlify cold start begins with only the built-in playbook. Re-registering
// the calls stored on the season must make its random custom id resolvable.
const customId = 'cp-cold-start-regression';
registerSeasonCalls({
  customPlays: [{ ...OFF_BY_ID.slants, id: customId, name: 'Cold Start Slants', custom: true }],
});
assert.equal(OFF_BY_ID[customId]?.name, 'Cold Start Slants',
  'saved custom offense should be registered in a fresh server process');

const customGame = {
  state: newGameState({ firstPossession: 'US' }),
  tendencies: { US: emptyTendencies(), CPU: emptyTendencies() },
  filmPoints: { OC: 0, DC: 0 },
  pending: {},
  autoSeat: 'DC',
  gameplan: { OC: { tempo: 'normal' }, DC: {} },
};
assert.doesNotThrow(() => runToNextDecision(
  'custom-cold-start', customGame, { callId: customId }),
'registered season play should resolve without an unknown-call error');

const ids = seasonCallIds({
  customPlays: [{ id: customId }],
  customDefenses: [{ id: 'cd-cold-start-regression' }],
});
assert.deepEqual([...ids], [customId, 'cd-cold-start-regression'],
  'the server cache should remain scoped to calls saved in this season');

// Live box scores record the slot a defender occupied during the game. The
// roster page may later promote that same player to another slot, but his
// existing season statistics must follow his stable identity.
const statSeason = createSeason({ seed: 'diag0', userTeam: TEAMS[0].id });
const defense = statSeason.rosters[statSeason.userTeam].defense;
const slotOrder = (a, b) => DEF_SPOTS.findIndex((s) => s.id === a)
  - DEF_SPOTS.findIndex((s) => s.id === b);
const movedPlayer = (pos) => {
  const group = defense.filter((p) => p.pos === pos);
  const slots = group.map((p) => p.spot).sort(slotOrder);
  return [...group].sort((a, b) => b.rating - a.rating)
    .find((p, i) => p.spot !== slots[i]);
};
const movedDt = movedPlayer('DT');
const movedCb = movedPlayer('CB');
assert.ok(movedDt && movedCb, 'fixture should reorder both a DT and a CB');
statSeason.results = [{
  final: true,
  home: statSeason.userTeam,
  away: TEAMS[1].id,
  players: { offense: [], defense: [
    { spot: movedDt.spot, pos: movedDt.pos, name: movedDt.name, tackles: 7, sacks: 1 },
    { spot: movedCb.spot, pos: movedCb.pos, name: movedCb.name, tackles: 4, pbu: 3, ints: 1 },
  ] },
}];
const defensiveStats = depthChart(statSeason, 'defense');
assert.equal(defensiveStats.find((p) => p.name === movedDt.name)?.tackles, 7,
  'DT statistics should survive a depth-chart slot change');
assert.equal(defensiveStats.find((p) => p.name === movedCb.name)?.pbu, 3,
  'CB statistics should survive a depth-chart slot change');

const finishedSeason = {
  results: [{ final: true, gameDocId: 'game-doc-1' }],
};
assert.equal(finishedGameRecorded(finishedSeason, 'game-doc-1'), true,
  'a matching repeated finish request should be idempotent');
assert.equal(finishedGameRecorded(finishedSeason, 'game-doc-2'), false,
  'a different game must not be mistaken for an already-finished one');

// Black Monday persists the complete offseason state to Firestore. Award
// summaries therefore need to be data, not formatter functions that the
// Firestore encoder cannot serialize.
let awardsSeason = createSeason({ seed: 'serializable-awards', userTeam: TEAMS[0].id });
for (let week = 1; week <= 18; week += 1) {
  awardsSeason = simRemainingWeek({ ...awardsSeason, week }, week);
}
const offseason = startOffseason({ ...awardsSeason, phase: 'done' });
const functionPaths = [];
const findFunctions = (value, path = 'season') => {
  if (typeof value === 'function') {
    functionPaths.push(path);
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    findFunctions(child, `${path}.${key}`);
  }
};
findFunctions(offseason);
assert.deepEqual(functionPaths, [],
  'offseason state sent to Firestore must not contain functions');
assert.equal(typeof offseason.awards.awards[0].winner.headline, 'string',
  'award headlines should be saved as display-ready strings');

// League games accumulate compact situational call counts without teaching
// CPU clubs a user's installed custom play.
const savedCallIds = new Set();
for (const team of Object.values(awardsSeason.filmBook)) {
  for (const unit of ['offense', 'defense']) {
    for (const calls of Object.values(team[unit] || {})) {
      Object.keys(calls).forEach((id) => savedCallIds.add(id));
    }
  }
}
assert.equal(savedCallIds.has(customId), false,
  'opponent tendency film should not include a user-installed custom call');
assert.ok(awardsSeason.filmBank.DC > 0,
  'completed staff games should accrue persistent film points');
assert.ok(awardsSeason.filmBank.OC > 0,
  'completed staff games should accrue offensive film points too');
const legacyFilmSave = dehydrate(awardsSeason);
delete legacyFilmSave.filmVersion;
legacyFilmSave.filmBank = { ...legacyFilmSave.filmBank, OC: 0 };
const migratedFilm = hydrate(structuredClone(legacyFilmSave));
const migratedAgain = hydrate(structuredClone(migratedFilm));
assert.ok(migratedFilm.filmBank.OC > 0,
  'existing careers should receive retroactive OC film points');
assert.equal(migratedAgain.filmBank.OC, migratedFilm.filmBank.OC,
  'the OC film migration should run only once');
assert.ok(Buffer.byteLength(JSON.stringify(dehydrate(offseason))) < 900_000,
  'a full season with league film must remain safely below Firestore document limits');

const filmUs = TEAMS[0].id, filmThem = TEAMS[1].id;
const detailedFilm = recordGameFilm(createSeason({ seed: 'detailed-film', userTeam: filmUs }), [{
  playIndex: 1,
  possession: 'CPU',
  down: 3,
  distance: 6,
  offId: 'mesh',
  defId: 'nick1',
  outcome: { yards: 12 },
}], { us: filmUs, them: filmThem }, { DC: 2 });
const thirdMedium = filmRows(detailedFilm.lastGameFilm.book, filmThem, 'offense', '3-med');
assert.equal(thirdMedium[0].callId, 'mesh');
assert.equal(thirdMedium[0].ypp, 12,
  'last-game film should preserve a call\'s actual effectiveness');
const unlockedFilm = unlockFilmOverlay(detailedFilm, 'DC', filmThem, 'mesh');
assert.equal(unlockedFilm.filmOverlays.DC.includes(`${filmThem}:mesh`), true);
assert.equal(unlockedFilm.filmBank.DC,
  detailedFilm.filmBank.DC - FILM_OVERLAY_COST,
  'unlocking an opponent diagram should spend the configured film cost');

// The designer exposes the upcoming opponent's complete stock playbook, not
// only calls which happened to appear in the finite tendency sample.
const designerFilm = createSeason({ seed: 'designer-film', userTeam: filmUs });
designerFilm.filmBank.DC = FILM_OVERLAY_COST;
const designerGame = designerFilm.schedule.games.find((g) => g.home === filmUs || g.away === filmUs);
designerFilm.week = designerGame.week;
const designerOpponent = designerGame.home === filmUs ? designerGame.away : designerGame.home;
const unseenCall = OFFENSE.find((p) => !p.custom
  && !Object.values(designerFilm.filmBook?.[designerOpponent]?.offense || {})
    .some((calls) => calls?.[p.id]));
assert.ok(unseenCall, 'fixture should include an unobserved built-in opponent call');
const designerUnlock = unlockFilmOverlay(designerFilm, 'DC', designerOpponent, unseenCall.id);
assert.equal(designerUnlock.filmOverlays.DC.includes(`${designerOpponent}:${unseenCall.id}`), true,
  'the upcoming opponent\'s default calls should unlock directly from the designer');

designerFilm.filmBank.OC = FILM_OVERLAY_COST;
const unseenDefense = DEFENSE.find((p) => !p.custom);
const offenseUnlock = unlockFilmOverlay(designerFilm, 'OC', designerOpponent, unseenDefense.id);
assert.equal(offenseUnlock.filmOverlays.OC.includes(`${designerOpponent}:${unseenDefense.id}`), true,
  'the OC should unlock an opponent defense directly from the offensive designer');
assert.equal(offenseUnlock.filmBank.OC, 0,
  'an offensive overlay should spend the same film cost');

for (const play of OFFENSE.filter((p) => !p.custom)) {
  assert.ok(Object.keys(opponentDiagram(play.id)?.paths || {}).length,
    `${play.name} should have an opponent-film diagram`);
}
for (const call of DEFENSE.filter((p) => !p.custom)) {
  assert.equal(Object.keys(opponentDefenseDiagram(call.id)?.paths || {}).length, 11,
    `${call.name} should diagram every defender`);
}
assert.ok(opponentDefenseDiagram('nick2').zones.length > 0,
  'zone calls should identify coverage landmarks for the overlay');
assert.equal(opponentDefenseDiagram('cover0').zones.length, 0,
  'man coverage should not draw zone landmarks');

// Installed drawings keep their exact paths. Against the same Cover 2 call,
// routes finishing in open grass must grade better than routes sitting on the
// underneath defenders' landmarks, even though both remain dropback passes.
const customPass = (id, assignments) => derivePlay({
  id, name: id, pers: '11', assignments, blockers: 0, blockerSpots: [],
});
const spaceFinder = customPass('space-finder', {
  WR1: [[3, 0], [3, 9], [13, 14]], WR2: [[50, 0], [50, 9], [42, 14]],
  WR3: [[17, 1], [27, 6]], TE1: [[35, 0], [27, 12]],
});
const zoneSitters = customPass('zone-sitters', {
  WR1: [[3, 0], [8, 5]], WR2: [[50, 0], [45, 5]],
  WR3: [[17, 1], [16, 8]], TE1: [[35, 0], [34, 10]],
});
assert.deepEqual(spaceFinder.geometry.paths.WR1.at(-1), { x: 13, y: 14 },
  'a custom play should preserve its original route coordinates');
assert.ok(Object.values(spaceFinder.geometry.paths).every((path) =>
  path.every((point) => !Array.isArray(point))),
'saved geometry should avoid Firestore-forbidden nested arrays');
const fullSpatialPlaybook = {
  ...offseason,
  customPlays: Array.from({ length: 40 }, (_, i) => ({ ...spaceFinder, id: `space-${i}` })),
};
assert.ok(Buffer.byteLength(JSON.stringify(dehydrate(fullSpatialPlaybook))) < 900_000,
  'forty geometry-backed calls should remain safely below the Firestore document limit');
const openSpatial = spatialMatchup(spaceFinder, DEF_BY_ID.nick2);
const closedSpatial = spatialMatchup(zoneSitters, DEF_BY_ID.nick2);
assert.ok(openSpatial.edge > closedSpatial.edge + 0.04,
  'exact route spacing should create a material matchup advantage');
assert.ok(computeEdge(spaceFinder, DEF_BY_ID.nick2)
  > computeEdge(zoneSitters, DEF_BY_ID.nick2) + 0.015,
  'the spatial advantage should survive the complete shell matchup calculation');
assert.ok(openSpatial.targetWeights.WR2 > spaceFinder.targets.WR2,
  'the quarterback read should favor a receiver whose route finds open space');
assert.notEqual(spatialMatchup(spaceFinder, DEF_BY_ID.cover0).edge, 0,
  'route separation should also be evaluated against man assignments');
const unprotectedBlitz = spatialMatchup(spaceFinder, DEF_BY_ID.agap);
const protectedBlitzPlay = derivePlay({
  id: 'protected-space-finder', name: 'Protected Space Finder', pers: '11',
  assignments: {
    WR1: [[3, 0], [3, 9], [13, 14]], WR2: [[50, 0], [50, 9], [42, 14]],
    WR3: [[17, 1], [27, 6]], TE1: [[35, 0], [27, 12]],
    RB1: [[24, -4], [23, -1]],
  },
  blockers: 1, blockerSpots: ['RB1'],
});
const protectedBlitz = spatialMatchup(protectedBlitzPlay, DEF_BY_ID.agap);
assert.ok(protectedBlitz.pressure > unprotectedBlitz.pressure,
  'a drawn protection path aligned with an extra rusher should reduce exact pressure');
registerCustomPlays([spaceFinder, zoneSitters]);
const spatialOutcome = resolveSnap(newGameState({ firstPossession: 'US' }),
  spaceFinder.id, 'nick2', () => 0.99, emptyTendencies());
assert.equal(spatialOutcome.designEdge, +openSpatial.edge.toFixed(3),
  'the snap resolver should apply and expose the exact design edge');
const legacySpaceFinder = { ...spaceFinder };
delete legacySpaceFinder.geometry;
assert.equal(spatialMatchup(legacySpaceFinder, DEF_BY_ID.nick2).edge, 0,
  'legacy custom calls without saved paths should keep their prior aggregate behavior');

const drawnZone = deriveDefense({
  id: 'drawn-zone', name: 'Drawn Zone', positions: {}, man: false,
  paths: {
    EDGE1: [[17, 1], [17, -3]], DT1: [[23, 1], [23, -3]],
    DT2: [[30, 1], [30, -3]], EDGE2: [[36, 1], [36, -3]],
    CB1: [[5, 6], [8, 5]], CB2: [[48, 6], [45, 5]], NB: [[14, 5], [16, 8]],
    LB1: [[23, 6], [22, 10]], LB2: [[31, 6], [34, 10]],
    S1: [[20, 13], [16, 20]], S2: [[34, 13], [38, 20]],
  },
});
assert.deepEqual(drawnZone.geometry.paths.S1.at(-1), { x: 16, y: 20 },
  'a custom defense should preserve its exact zone landmarks');
assert.notEqual(spatialMatchup(OFF_BY_ID.mesh, drawnZone).edge, 0,
  'built-in offense should be spatially evaluated against a drawn defense');

console.log('Regression tests passed.');
