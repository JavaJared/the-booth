// gameflow.js — the turn loop, shared by the Cloud Function and local mode so
// the two can never drift apart.
import {
  advance, resolveSnap, resolveSpecial, mulberry32, hashSeed,
  cpuDefensiveCall, cpuOffensiveCall, cpuFourthDown, recordTendency,
  resolveConversion, cpuConversion, callTimeout,
} from './engine.js';
import { OFF_BY_ID, DEF_BY_ID } from './playbook.js';
import { makeRosters } from './roster.js';
import { teamOffensiveIdentity } from './film.js';

export const PLAY_CLOCK_MS = 45000;
export const FILM_COST = 3;

/** Which seat has to make the call right now. */
export const seatOnClock = (state) => {
  // Only our own touchdown is a decision. When the opponent scores, their
  // conversion is theirs to take — routing it to the defensive coordinator
  // left him staring at a call sheet for a play he does not make.
  if (state.pendingConversion) {
    return state.pendingConversion.team === 'US' ? 'OC'
      : (state.possession === 'US' ? 'OC' : 'DC');
  }
  return state.possession === 'US' ? 'OC' : 'DC';
};

/** Whose timeouts these are. Either coordinator can burn one on their own unit. */
export const timeoutSide = (seat) => (seat === 'OC' ? 'US' : 'US');

// Separate RNG streams so a "read keys" hint can be truthful without
// disturbing the roll that resolves the play.
export const cpuRng = (gameId, i) => mulberry32(hashSeed(`${gameId}:cpu:${i}`));
export const playRng = (gameId, i) => mulberry32(hashSeed(`${gameId}:play:${i}`));

/** The truthful, partial tell that film points buy. */
export function keyRead(gameId, game) {
  const { state } = game;
  const rng = cpuRng(gameId, state.playIndex);
  if (state.possession === 'US') {
    const d = DEF_BY_ID[cpuDefensiveCall(state, game.tendencies.US, rng)];
    const shell = d.cov.startsWith('man') ? 'man coverage' : 'zone behind it';
    const heat = d.rush > 4 ? ', extra rusher' : d.box >= 8 ? ', loaded box' : '';
    return `Keys say ${shell}${heat}.`;
  }
  const identity = game.cpuIdentity || teamOffensiveIdentity(game.seasonSeed || gameId,
    game.them || game.oppName || 'CPU');
  const o = OFF_BY_ID[cpuOffensiveCall(state, game.tendencies.CPU, rng, identity)];
  const bucket = { run: 'run', shot: 'a shot downfield', screen: 'a screen',
    playaction: 'play action', quick: 'the quick game', dropback: 'a called pass' }[o.family];
  return `Splits and personnel point to ${bucket}.`;
}

function logEntry(playIndex, before, outcome, events, meta) {
  return {
    playIndex, at: Date.now(),
    down: before.down, distance: before.distance, ballOn: before.ballOn,
    possession: before.possession, quarter: before.quarter, clock: before.clock,
    scoreBefore: before.score,
    outcome: JSON.parse(JSON.stringify(outcome)),
    events, ...meta,
  };
}

/**
 * Run the human's call, then keep simulating any snap that needs no human
 * input (a CPU punt or field goal) until a coordinator is back on the clock.
 * Pure: returns new state, never mutates the input game.
 */
export function runToNextDecision(gameId, game, humanCall) {
  let state = JSON.parse(JSON.stringify(game.state));
  const tendencies = JSON.parse(JSON.stringify(game.tendencies));
  const filmPoints = { ...game.filmPoints };
  const plays = [];
  // A timeout is not a snap: it stops the clock and hands the decision back.
  if (humanCall.timeout) {
    const t = callTimeout(state, 'US');
    return {
      plays: t.spent ? [logEntry(state.playIndex, state, { desc: 'Timeout.', special: 'timeout', yards: 0 },
        t.events, { timeout: true, byHuman: true })] : [],
      state: t.state, tendencies, filmPoints,
    };
  }

  let pendingSpecial = humanCall.special || null;
  // `auto` means even the first snap is AI-called — needed when the unit on the
  // clock belongs to the AI coordinator, such as the opening kickoff going the
  // other way. Without it the game stalls before the human ever sees a sheet.
  let humanTurn = !humanCall.auto;
  let guard = 0;
  // In a solo season your counterpart is an AI coordinator, so one seat runs
  // itself. In two-player this is null and both seats belong to humans.
  const autoSeat = game.autoSeat || null;
  // A season hands us the real teams; an exhibition falls back to the seed.
  const rosters = game.rosters || makeRosters(game.rosterSeed || gameId);
  const cpuIdentity = game.cpuIdentity || teamOffensiveIdentity(game.seasonSeed || gameId,
    game.them || game.oppName || 'CPU');

  while (guard++ < 400) {
    const i = state.playIndex;
    const humanHasBall = state.possession === 'US';
    const rngCpu = cpuRng(gameId, i);
    const rng = playRng(gameId, i);
    const before = JSON.parse(JSON.stringify(state));

    // A touchdown pauses here for the conversion.
    if (state.pendingConversion) {
      // Ours is a decision; theirs resolves itself.
      const ours = state.pendingConversion.team === 'US';
      const auto = !ours || autoSeat === 'OC';
      const choice = (humanTurn && humanCall.conversion) ? humanCall.conversion
        : auto ? cpuConversion(state, rngCpu) : null;
      if (!choice) break;                      // a human owes us this decision
      const r = resolveConversion(state, choice, rng);
      plays.push(logEntry(i, before, r.outcome, r.events, { conversion: choice, byHuman: humanTurn }));
      state = r.state;
      humanTurn = false;
      if (state.status === 'final') break;
      // Surface the conversion on its own so the result of a decision you just
      // made is visible — but only stop if a human is actually next. Breaking
      // unconditionally stranded the AI-run unit that receives the kickoff.
      if (seatOnClock(state) !== autoSeat) break;
      continue;
    }

    if (pendingSpecial) {
      const r = resolveSpecial(state, pendingSpecial, rng);
      plays.push(logEntry(i, before, r.outcome, r.events, { special: pendingSpecial, byHuman: humanTurn }));
      state = r.state;
    } else {
      let offId, defId;
      if (humanHasBall) {
        offId = humanTurn ? humanCall.callId : cpuOffensiveCall(state, tendencies.US, rngCpu);
        defId = cpuDefensiveCall(state, tendencies.US, rngCpu);
      } else {
        offId = cpuOffensiveCall(state, tendencies.CPU, rngCpu, cpuIdentity);
        defId = humanTurn ? humanCall.callId : cpuDefensiveCall(state, tendencies.CPU, rngCpu);
      }
      const off = OFF_BY_ID[offId], def = DEF_BY_ID[defId];
      if (!off || !def) throw new Error(`unknown call ${offId} / ${defId}`);

      const side = humanHasBall ? 'US' : 'CPU';
      recordTendency(tendencies[side], state, off.family);

      const plan = humanHasBall ? game.gameplan.OC : null;
      const practiceEdge = humanHasBall
        ? (game.practice?.OC?.plays?.[offId] || 0)
        : -(game.practice?.DC?.plays?.[defId] || 0);
      const practiceReps = humanHasBall
        ? (game.practice?.OC?.playReps?.[offId] || 0)
        : (game.practice?.DC?.playReps?.[defId] || 0);
      const outcome = resolveSnap(state, offId, defId, rng, tendencies[side], {
        offense: plan,
        practiceEdge, practiceReps,
        offRoster: humanHasBall ? rosters.US.offense : rosters.CPU.offense,
        defRoster: humanHasBall ? rosters.CPU.defense : rosters.US.defense,
      });
      const { state: next, events } = advance(state, outcome, {
        tempo: humanHasBall ? game.gameplan.OC?.tempo : 'normal',
      });

      // Grade the idle coordinator's read.
      if (humanTurn && game.pending?.prediction?.playIndex === i) {
        const pred = game.pending.prediction;
        const actual = humanHasBall
          ? (def.rush > 4 ? 'blitz' : def.cov.startsWith('man') ? 'man' : 'zone')
          : off.family;
        outcome.predictionActual = actual;
        outcome.predictionHit = actual === pred.guess;
        outcome.predictionSeat = pred.seat;
        if (outcome.predictionHit) filmPoints[pred.seat] = (filmPoints[pred.seat] || 0) + 1;
      }

      plays.push(logEntry(i, before, outcome, events, { offId, defId, byHuman: humanTurn }));
      state = next;
    }

    humanTurn = false;
    pendingSpecial = null;

    // Can another snap run without a human? Two cases qualify: the side with
    // the ball is choosing to kick, or the unit on the clock is AI-run.
    if (state.status === 'final') break;
    // The opponent owns its conversion decision. Resolve it in this same
    // server turn instead of returning a pending choice to our defensive
    // coordinator. This must happen before the auto-seat check: in a solo
    // season the DC can be human even though the CPU offense is not.
    if (state.pendingConversion?.team === 'CPU') continue;
    const offenseIsOurs = state.possession === 'US';
    const offenseIsAuto = offenseIsOurs ? autoSeat === 'OC' : true;
    if (state.down === 4 && offenseIsAuto) {
      const decision = cpuFourthDown(state, cpuRng(gameId, state.playIndex), offenseIsOurs);
      if (decision !== 'go') { pendingSpecial = decision; continue; }
    }
    if (seatOnClock(state) === autoSeat) continue;
    break;
  }

  return { plays, state, tendencies, filmPoints };
}
