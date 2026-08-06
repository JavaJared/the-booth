// playbook.js — the football IQ of the game. Tunable data, no logic.
// Coverage families: man0, man1, cover2, tampa2, cover3, quarters, cover6
// Play families: run, quick, screen, dropback, playaction, shot

export const COVERAGES = ['man0', 'man1', 'cover2', 'tampa2', 'cover3', 'quarters', 'cover6'];
export const FAMILIES = ['run', 'quick', 'screen', 'dropback', 'playaction', 'shot'];

export const FAMILY_LABEL = {
  run: 'Run',
  quick: 'Quick game',
  screen: 'Screen',
  dropback: 'Dropback pass',
  playaction: 'Play action',
  shot: 'Deep shot',
};

// --- OFFENSE -----------------------------------------------------------
// Pass plays:
//   comp      base completion probability vs a neutral shell
//   mean/sd   yards on a completion
//   sack      base sack probability with 4 rushers
//   int       base interception probability
//   expl      chance a completion becomes an explosive (adds a big tail)
//   vs        completion-probability delta against each coverage family
//   blitzFit  how the concept handles extra rushers (+ good, - bad)
// Run plays:
//   success   chance of a "good" carry
//   mean/sd   yards
//   stuff     chance of a loss/no-gain
//   fumble    fumble probability
//   edge      'inside' | 'outside' — decides which fronts hurt it
//   boxFit    sensitivity to a loaded box (higher = suffers more)

export const OFFENSE = [
  // ---- Runs
  { id: 'iz', name: 'Inside Zone', family: 'run', pers: '11', tag: 'Base run',
    success: 0.515, mean: 5.217, sd: 3.4, stuff: 0.14, fumble: 0.008, edge: 'inside', boxFit: 1.0 },
  { id: 'oz', name: 'Outside Zone', family: 'run', pers: '12', tag: 'Stretch',
    success: 0.4944, mean: 5.542, sd: 4.4, stuff: 0.18, fumble: 0.008, edge: 'outside', boxFit: 0.85 },
  { id: 'power', name: 'Power O', family: 'run', pers: '21', tag: 'Downhill',
    success: 0.5562, mean: 4.89, sd: 2.9, stuff: 0.12, fumble: 0.007, edge: 'inside', boxFit: 1.25 },
  { id: 'counter', name: 'Counter Trey', family: 'run', pers: '12', tag: 'Misdirection',
    success: 0.5047, mean: 5.869, sd: 4.6, stuff: 0.17, fumble: 0.009, edge: 'inside', boxFit: 0.75 },
  { id: 'toss', name: 'Toss Sweep', family: 'run', pers: '11', tag: 'Perimeter',
    success: 0.4635, mean: 5.977, sd: 5.2, stuff: 0.22, fumble: 0.010, edge: 'outside', boxFit: 0.70 },
  { id: 'draw', name: 'QB Draw', family: 'run', pers: '10', tag: 'Beats pressure',
    success: 0.4841, mean: 5.977, sd: 4.8, stuff: 0.19, fumble: 0.010, edge: 'inside', boxFit: 0.45 },
  { id: 'trap', name: 'Trap', family: 'run', pers: '11', tag: 'Beats penetration',
    success: 0.5253, mean: 5.325, sd: 3.9, stuff: 0.15, fumble: 0.008, edge: 'inside', boxFit: 0.65 },
  { id: 'sneak', name: 'QB Sneak', family: 'run', pers: 'heavy', tag: 'Short yardage',
    success: 0.8034, mean: 1.739, sd: 1.1, stuff: 0.08, fumble: 0.006, edge: 'inside', boxFit: 1.6 },

  // ---- Quick game
  { id: 'slants', name: 'Slants', family: 'quick', pers: '11', tag: 'Beats man',
    comp: 0.6726, mean: 7.173, sd: 4.2, sack: 0.0342, int: 0.0248, expl: 0.065,
    vs: { man0: 0.10, man1: 0.08, cover2: -0.03, tampa2: -0.02, cover3: 0.01, quarters: 0.00, cover6: -0.01 },
    blitzFit: 0.9 },
  { id: 'stick', name: 'Stick', family: 'quick', pers: '11', tag: 'Zone beater',
    comp: 0.6998, mean: 6.303, sd: 3.4, sack: 0.0319, int: 0.0165, expl: 0.03,
    vs: { man0: -0.02, man1: -0.02, cover2: 0.05, tampa2: 0.04, cover3: 0.06, quarters: 0.05, cover6: 0.05 },
    blitzFit: 0.85 },
  { id: 'hitches', name: 'Hitches', family: 'quick', pers: '10', tag: 'Answer to soft',
    comp: 0.7183, mean: 5.869, sd: 3.0, sack: 0.0296, int: 0.0189, expl: 0.02,
    vs: { man0: -0.04, man1: -0.03, cover2: 0.03, tampa2: 0.03, cover3: 0.07, quarters: 0.06, cover6: 0.05 },
    blitzFit: 0.80 },
  { id: 'spacing', name: 'Spacing', family: 'quick', pers: '11', tag: 'Third and short',
    comp: 0.7271, mean: 5.542, sd: 2.8, sack: 0.0274, int: 0.0142, expl: 0.02,
    vs: { man0: -0.03, man1: -0.03, cover2: 0.04, tampa2: 0.05, cover3: 0.05, quarters: 0.04, cover6: 0.04 },
    blitzFit: 0.90 },

  // ---- Screens
  { id: 'rbscreen', name: 'RB Screen', family: 'screen', pers: '11', tag: 'Punish pressure',
    comp: 0.7271, mean: 6.956, sd: 6.0, sack: 0.0228, int: 0.0153, expl: 0.14,
    vs: { man0: 0.09, man1: 0.06, cover2: -0.04, tampa2: -0.05, cover3: -0.02, quarters: -0.03, cover6: -0.03 },
    blitzFit: 1.5 },
  { id: 'tunnel', name: 'Tunnel Screen', family: 'screen', pers: '10', tag: 'Perimeter',
    comp: 0.7543, mean: 6.086, sd: 5.2, sack: 0.0182, int: 0.0118, expl: 0.08,
    vs: { man0: 0.05, man1: 0.04, cover2: -0.02, tampa2: -0.02, cover3: 0.01, quarters: 0.00, cover6: 0.00 },
    blitzFit: 1.3 },

  // ---- Dropback
  { id: 'mesh', name: 'Mesh', family: 'dropback', pers: '11', tag: 'Man beater',
    comp: 0.6542, mean: 8.803, sd: 4.8, sack: 0.0661, int: 0.0236, expl: 0.075,
    vs: { man0: 0.12, man1: 0.11, cover2: -0.03, tampa2: -0.05, cover3: -0.02, quarters: -0.03, cover6: -0.03 },
    blitzFit: 0.35 },
  { id: 'flood', name: 'Flood', family: 'dropback', pers: '12', tag: 'Beats Cover 3',
    comp: 0.6182, mean: 10.433, sd: 5.6, sack: 0.0752, int: 0.0271, expl: 0.15,
    vs: { man0: -0.04, man1: -0.03, cover2: 0.02, tampa2: 0.01, cover3: 0.11, quarters: 0.02, cover6: 0.06 },
    blitzFit: -0.10 },
  { id: 'dagger', name: 'Dagger', family: 'dropback', pers: '11', tag: 'Clears the hook',
    comp: 0.591, mean: 12.172, sd: 6.4, sack: 0.0821, int: 0.0307, expl: 0.14,
    vs: { man0: -0.03, man1: 0.01, cover2: 0.09, tampa2: 0.04, cover3: 0.06, quarters: -0.02, cover6: 0.03 },
    blitzFit: -0.25 },
  { id: 'smash', name: 'Smash', family: 'dropback', pers: '11', tag: 'Beats Cover 2',
    comp: 0.6085, mean: 10.759, sd: 5.8, sack: 0.0707, int: 0.0283, expl: 0.14,
    vs: { man0: -0.02, man1: 0.00, cover2: 0.12, tampa2: 0.08, cover3: -0.01, quarters: 0.03, cover6: 0.07 },
    blitzFit: -0.10 },
  { id: 'ycross', name: 'Y-Cross', family: 'dropback', pers: '11', tag: 'Man beater',
    comp: 0.5997, mean: 11.303, sd: 6.0, sack: 0.0798, int: 0.0283, expl: 0.15,
    vs: { man0: 0.09, man1: 0.10, cover2: 0.00, tampa2: -0.03, cover3: 0.02, quarters: -0.02, cover6: 0.00 },
    blitzFit: -0.30 },
  { id: 'curlflat', name: 'Curl-Flat', family: 'dropback', pers: '11', tag: 'Zone control',
    comp: 0.6639, mean: 8.042, sd: 4.0, sack: 0.0547, int: 0.0201, expl: 0.04,
    vs: { man0: -0.05, man1: -0.04, cover2: 0.05, tampa2: 0.05, cover3: 0.08, quarters: 0.06, cover6: 0.06 },
    blitzFit: 0.15 },
  { id: 'comebacks', name: 'Sideline Comebacks', family: 'dropback', pers: '11', tag: 'Clock work',
    comp: 0.5638, mean: 13.15, sd: 5.0, sack: 0.0798, int: 0.033, expl: 0.075, oob: 0.65,
    vs: { man0: 0.02, man1: 0.03, cover2: -0.04, tampa2: 0.00, cover3: 0.04, quarters: -0.03, cover6: 0.00 },
    blitzFit: -0.30 },

  // ---- Play action
  { id: 'paboot', name: 'PA Boot', family: 'playaction', pers: '12', tag: 'Moves the pocket',
    comp: 0.6726, mean: 9.781, sd: 5.2, sack: 0.0593, int: 0.0224, expl: 0.08,
    vs: { man0: 0.04, man1: 0.05, cover2: 0.02, tampa2: 0.02, cover3: 0.04, quarters: 0.03, cover6: 0.03 },
    blitzFit: 0.55, paBonus: 1.0 },
  { id: 'padig', name: 'PA Dig', family: 'playaction', pers: '12', tag: 'Attacks the box',
    comp: 0.6085, mean: 13.042, sd: 6.2, sack: 0.0889, int: 0.0295, expl: 0.15,
    vs: { man0: 0.01, man1: 0.03, cover2: 0.05, tampa2: 0.02, cover3: 0.05, quarters: -0.01, cover6: 0.03 },
    blitzFit: -0.45, paBonus: 1.05 },

  // ---- Shots
  { id: 'verts', name: 'Four Verticals', family: 'shot', pers: '10', tag: 'Beats single high',
    comp: 0.372, mean: 21.5, sd: 9.5, sack: 0.108, int: 0.062, expl: 0.30,
    vs: { man0: 0.05, man1: 0.05, cover2: -0.06, tampa2: -0.12, cover3: 0.09, quarters: -0.11, cover6: -0.02 },
    blitzFit: -0.35 },
  { id: 'postwheel', name: 'Post-Wheel', family: 'shot', pers: '11', tag: 'Beats man',
    comp: 0.358, mean: 23.0, sd: 10.5, sack: 0.112, int: 0.066, expl: 0.34,
    vs: { man0: 0.12, man1: 0.11, cover2: -0.05, tampa2: -0.09, cover3: -0.01, quarters: -0.10, cover6: -0.04 },
    blitzFit: -0.30 },
  { id: 'pashot', name: 'PA Deep Shot', family: 'shot', pers: '12', tag: 'Off run action',
    comp: 0.385, mean: 24.5, sd: 10.0, sack: 0.118, int: 0.06, expl: 0.36,
    vs: { man0: 0.04, man1: 0.05, cover2: -0.04, tampa2: -0.08, cover3: 0.07, quarters: -0.13, cover6: -0.02 },
    blitzFit: -0.50, paBonus: 1.15 },
];

// --- DEFENSE -----------------------------------------------------------
//   cov       coverage family
//   box       defenders in the box (7 is neutral)
//   rush      pass rushers (4 is neutral)
//   runCommit extra aggression vs the run; costs you on play action
//   pers      base | nickel | dime | heavy

export const DEFENSE = [
  { id: 'base3', name: 'Base Cover 3', cov: 'cover3', box: 7, rush: 4, runCommit: 0.10, pers: 'base', tag: 'Sound vs everything' },
  { id: 'nick3', name: 'Nickel Cover 3', cov: 'cover3', box: 6, rush: 4, runCommit: 0.00, pers: 'nickel', tag: 'Standard down' },
  { id: 'cloud3', name: 'Cover 3 Cloud', cov: 'cover3', box: 6, rush: 4, runCommit: 0.00, pers: 'nickel', tag: 'Caps the boundary' },
  { id: 'nick1', name: 'Nickel Cover 1', cov: 'man1', box: 7, rush: 4, runCommit: 0.10, pers: 'nickel', tag: 'Man free' },
  { id: 'nick2', name: 'Nickel Cover 2', cov: 'cover2', box: 6, rush: 4, runCommit: -0.05, pers: 'nickel', tag: 'Two deep' },
  { id: 'tampa', name: 'Tampa 2', cov: 'tampa2', box: 6, rush: 4, runCommit: -0.05, pers: 'nickel', tag: 'Closes the seam' },
  { id: 'quarters', name: 'Quarters', cov: 'quarters', box: 7, rush: 4, runCommit: 0.05, pers: 'nickel', tag: 'Caps the deep' },
  { id: 'cover6', name: 'Cover 6', cov: 'cover6', box: 6, rush: 4, runCommit: 0.00, pers: 'nickel', tag: 'Split field' },
  { id: 'base4', name: 'Base Cover 4', cov: 'quarters', box: 7, rush: 4, runCommit: 0.15, pers: 'base', tag: 'Run support' },
  { id: 'bear1', name: 'Bear Front Cover 1', cov: 'man1', box: 8, rush: 4, runCommit: 0.30, pers: 'base', tag: 'Stuffs the interior' },
  { id: 'runblitz', name: 'Run Blitz Cover 2', cov: 'cover2', box: 8, rush: 5, runCommit: 0.35, pers: 'base', tag: 'Attacks the run' },
  { id: 'firezone', name: 'Fire Zone', cov: 'cover3', box: 7, rush: 5, runCommit: 0.05, pers: 'nickel', tag: 'Pressure, zone behind' },
  { id: 'simpress', name: 'Simulated Pressure', cov: 'man1', box: 7, rush: 4, runCommit: 0.05, pers: 'nickel', tag: 'Shows blitz, drops out' },
  { id: 'agap', name: 'Double A-Gap Cover 1', cov: 'man1', box: 8, rush: 5, runCommit: 0.20, pers: 'nickel', tag: 'Interior heat' },
  { id: 'nickblitz', name: 'Nickel Blitz Cover 1', cov: 'man1', box: 7, rush: 5, runCommit: 0.05, pers: 'nickel', tag: 'Five man pressure' },
  { id: 'cover0', name: 'Cover 0 Blitz', cov: 'man0', box: 8, rush: 6, runCommit: 0.15, pers: 'nickel', tag: 'Everybody comes' },
  { id: 'dime0', name: 'Dime Cover 0', cov: 'man0', box: 6, rush: 6, runCommit: -0.05, pers: 'dime', tag: 'Obvious pass heat' },
  { id: 'dime4', name: 'Dime Cover 4', cov: 'quarters', box: 5, rush: 4, runCommit: -0.20, pers: 'dime', tag: 'Two minute' },
  { id: 'prevent', name: 'Prevent', cov: 'cover2', box: 5, rush: 3, runCommit: -0.35, pers: 'dime', tag: 'No big plays' },
  { id: 'goalline', name: 'Goal Line', cov: 'man1', box: 9, rush: 4, runCommit: 0.45, pers: 'heavy', tag: 'Short yardage' },
];

export const OFF_BY_ID = Object.fromEntries(OFFENSE.map((p) => [p.id, p]));
export const DEF_BY_ID = Object.fromEntries(DEFENSE.map((p) => [p.id, p]));

// Personnel mismatch: offense heavy vs defense light helps the run, and
// offense spread vs defense heavy helps the pass.
export const PERS_WEIGHT = { '10': 0, '11': 1, '12': 2, '21': 2.5, heavy: 3.5 };
export const DEF_PERS_WEIGHT = { dime: 0, nickel: 1, base: 2, heavy: 3.5 };
