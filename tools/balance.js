// Simulates N full games with CPU on both sides and reports whether the
// engine produces football-shaped numbers. Run: node tools/balance.js 400
import {
  newGameState, advance, resolveSnap, resolveSpecial, mulberry32, hashSeed,
  cpuDefensiveCall, cpuOffensiveCall, cpuFourthDown,
  emptyTendencies, recordTendency,
} from '../shared/engine.js';
import { OFF_BY_ID } from '../shared/playbook.js';

const N = parseInt(process.argv[2] || '300', 10);

const agg = {
  games: 0, plays: 0, points: 0, yards: 0, passAtt: 0, comp: 0, passYds: 0,
  sacks: 0, ints: 0, fumblesLost: 0, rushes: 0, rushYds: 0, expl: 0,
  drives: 0, tds: 0, fgs: 0, punts: 0, penalties: 0, thirdAtt: 0, thirdConv: 0,
  scoreDist: [],
};

for (let g = 0; g < N; g++) {
  let rng = mulberry32(hashSeed('game' + g));
  let state = newGameState({ firstPossession: g % 2 ? 'US' : 'CPU' });
  const tend = { US: emptyTendencies(), CPU: emptyTendencies() };
  let guard = 0;

  while (state.status !== 'final' && guard++ < 400) {
    const offSide = state.possession;
    const defSide = offSide === 'US' ? 'CPU' : 'US';

    if (state.down === 4) {
      const decision = cpuFourthDown(state, rng);
      if (decision !== 'go') {
        const r = resolveSpecial(state, decision, rng);
        if (decision === 'fg') { agg.fgs++; } else agg.punts++;
        state = r.state; agg.drives++;
        continue;
      }
    }

    const offId = cpuOffensiveCall(state, tend[offSide], rng, { runLean: 0.1 });
    const defId = cpuDefensiveCall(state, tend[defSide], rng);
    const off = OFF_BY_ID[offId];
    const thirdDown = state.down === 3;
    const needed = state.distance;

    recordTendency(tend[offSide], state, off.family);
    const outcome = resolveSnap(state, offId, defId, rng, tend[offSide], {});
    const before = state.ballOn;
    const { state: next, events } = advance(state, outcome, {});

    agg.plays++;
    if (outcome.penalty) agg.penalties++;
    if (!outcome.penalty || !outcome.penalty.replay) {
      if (off.family === 'run') { agg.rushes++; agg.rushYds += outcome.yards; }
      else if (outcome.sack) { agg.sacks++; }
      else if (outcome.turnover === 'interception') { agg.ints++; agg.passAtt++; }
      else if (outcome.complete !== null) {
        agg.passAtt++;
        if (outcome.complete) { agg.comp++; agg.passYds += outcome.yards; }
      }
      if (outcome.turnover === 'fumble') agg.fumblesLost++;
      if (outcome.yards >= 20) agg.expl++;
      agg.yards += outcome.yards;
    }
    if (thirdDown && !outcome.penalty) {
      agg.thirdAtt++;
      if (outcome.yards >= needed && !outcome.turnover) agg.thirdConv++;
    }
    for (const e of events) { if (e.type === 'score' && e.text.includes('Touchdown')) agg.tds++; }
    state = next;
  }
  agg.games++;
  agg.points += state.score.us + state.score.them;
  agg.scoreDist.push(state.score.us, state.score.them);
}

const p = (x, d = 1) => x.toFixed(d);
const per = agg.games;
console.log(`\n=== ${agg.games} games simulated ===`);
const rows = [
  ['Plays / game', p(agg.plays / per), '120 – 132'],
  ['Points / game (both)', p(agg.points / per), '43 – 47'],
  ['Yards / play', p(agg.yards / agg.plays, 2), '5.3 – 5.7'],
  ['Completion %', p((agg.comp / agg.passAtt) * 100), '63 – 67'],
  ['Yards / attempt', p(agg.passYds / agg.passAtt, 2), '6.8 – 7.4'],
  ['Yards / carry', p(agg.rushYds / agg.rushes, 2), '4.2 – 4.6'],
  ['Sack rate', p((agg.sacks / (agg.passAtt + agg.sacks)) * 100, 1) + '%', '6.0 – 7.5%'],
  ['INT rate', p((agg.ints / agg.passAtt) * 100, 1) + '%', '2.0 – 2.6%'],
  ['Run/pass split', p((agg.rushes / agg.plays) * 100) + '% run', '41 – 45%'],
  ['3rd down conv.', p((agg.thirdConv / agg.thirdAtt) * 100) + '%', '38 – 42%'],
  ['Explosive (20+) rate', p((agg.expl / agg.plays) * 100, 1) + '%', '4.5 – 6.0%'],
  ['TDs / game (both)', p(agg.tds / per, 2), '4.4 – 5.2'],
  ['FG att / game', p(agg.fgs / per, 2), '3.4 – 4.2'],
  ['Punts / game', p(agg.punts / per, 2), '8.0 – 9.5'],
  ['Penalties / game', p(agg.penalties / per, 1), '11 – 14'],
];
const w = Math.max(...rows.map((r) => r[0].length));
for (const [k, v, target] of rows) {
  console.log(`${k.padEnd(w)}  ${String(v).padStart(9)}   target ${target}`);
}
const sorted = [...agg.scoreDist].sort((a, b) => a - b);
console.log(`\nTeam score median ${sorted[Math.floor(sorted.length / 2)]}, ` +
  `10th pct ${sorted[Math.floor(sorted.length * 0.1)]}, 90th pct ${sorted[Math.floor(sorted.length * 0.9)]}`);
