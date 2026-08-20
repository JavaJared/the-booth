import assert from 'node:assert/strict';
import { newGameState, emptyTendencies } from '../public/shared/engine.js';
import { runToNextDecision } from '../public/shared/gameflow.js';
import { OFF_BY_ID, registerSeasonCalls, seasonCallIds } from '../public/shared/playbook.js';
import { createSeason, finishedGameRecorded } from '../public/shared/season.js';
import { TEAMS } from '../public/shared/league.js';
import { DEF_SPOTS } from '../public/shared/roster.js';
import { depthChart } from '../public/shared/depth.js';

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

console.log('Regression tests passed.');
