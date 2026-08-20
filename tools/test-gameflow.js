import assert from 'node:assert/strict';
import { newGameState, emptyTendencies } from '../public/shared/engine.js';
import { runToNextDecision } from '../public/shared/gameflow.js';
import { OFF_BY_ID, registerSeasonCalls, seasonCallIds } from '../public/shared/playbook.js';

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

console.log('Game-flow tests passed.');
