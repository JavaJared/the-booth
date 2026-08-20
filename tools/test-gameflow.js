import assert from 'node:assert/strict';
import { newGameState, emptyTendencies } from '../public/shared/engine.js';
import { runToNextDecision } from '../public/shared/gameflow.js';

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

console.log('Game-flow tests passed.');
