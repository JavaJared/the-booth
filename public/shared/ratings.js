// ratings.js — the shared language for player ability.
//
// Draft scouting, roster progression and the snap resolver all import this
// file so an "A route runner" means the same thing everywhere in the game.

export const TRAITS = {
  arm: 'Arm talent', acc: 'Accuracy', poise: 'Pocket poise', field: 'Field vision',
  speed: 'Speed', burst: 'Burst', agility: 'Agility', power: 'Power',
  hands: 'Hands', route: 'Route running', release: 'Release',
  block: 'Blocking', anchor: 'Anchor', pull: 'Mobility',
  rush: 'Pass rush', shed: 'Block shedding', tackle: 'Tackling',
  cover: 'Coverage', instinct: 'Instincts', range: 'Range', press: 'Press',
  motor: 'Motor', frame: 'Frame',
};

/** The overall is a summary of the abilities that actually matter at a spot. */
export const POSITION_TRAITS = {
  QB:   { arm: 0.25, acc: 0.30, poise: 0.25, field: 0.20 },
  RB:   { speed: 0.22, burst: 0.20, agility: 0.20, power: 0.18, hands: 0.12, frame: 0.08 },
  WR:   { speed: 0.22, hands: 0.23, route: 0.25, release: 0.16, burst: 0.14 },
  TE:   { hands: 0.22, route: 0.18, block: 0.25, frame: 0.18, speed: 0.17 },
  OL:   { block: 0.30, anchor: 0.27, pull: 0.17, frame: 0.14, motor: 0.12 },
  EDGE: { rush: 0.31, burst: 0.21, shed: 0.19, motor: 0.17, frame: 0.12 },
  DT:   { power: 0.27, shed: 0.25, anchor: 0.23, motor: 0.15, frame: 0.10 },
  LB:   { tackle: 0.23, instinct: 0.25, cover: 0.18, speed: 0.17, shed: 0.17 },
  CB:   { cover: 0.29, speed: 0.24, press: 0.18, instinct: 0.15, agility: 0.14 },
  NB:   { cover: 0.27, agility: 0.22, instinct: 0.20, speed: 0.17, tackle: 0.14 },
  S:    { range: 0.25, instinct: 0.24, tackle: 0.20, cover: 0.20, speed: 0.11 },
};

const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

function gauss(rng, mean, sd) {
  let u = 0, v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return mean + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

export function ratingFromTraits(pos, traits, fallback = 75) {
  const weights = POSITION_TRAITS[pos];
  if (!weights || !traits) return Math.round(fallback);
  return Math.round(clamp(Object.entries(weights).reduce((sum, [key, weight]) =>
    sum + (Number.isFinite(traits[key]) ? traits[key] : fallback) * weight, 0), 40, 99));
}

/**
 * Give an existing overall a deterministic, lopsided trait profile without
 * materially changing that overall. This is the migration path for every
 * career created before position ratings existed.
 */
export function traitsFromRating(pos, overall, rng) {
  const weights = POSITION_TRAITS[pos];
  if (!weights) return null;
  const traits = {};
  for (const key of Object.keys(weights)) traits[key] = Math.round(clamp(gauss(rng, overall, 7), 35, 99));
  // Shift the whole profile back toward the known overall, then correct the
  // largest-weight trait for rounding. The player stays equally good overall
  // while gaining real strengths and weaknesses.
  const shift = overall - ratingFromTraits(pos, traits, overall);
  for (const key of Object.keys(traits)) traits[key] = Math.round(clamp(traits[key] + shift, 35, 99));
  const priority = Object.keys(weights).sort((a, b) => weights[b] - weights[a]);
  for (let guard = 0; guard < 16; guard++) {
    const gap = overall - ratingFromTraits(pos, traits, overall);
    if (!gap) break;
    // Moving only the primary trait fails near 99 when that attribute is
    // already capped. Nudge the whole relevant profile in weight order.
    for (const key of priority) traits[key] = Math.round(clamp(traits[key] + Math.sign(gap), 35, 99));
  }
  return traits;
}

export const developmentFromRng = (rng) => {
  const roll = rng();
  return roll < 0.16 ? 'quick' : roll > 0.86 ? 'slow' : 'normal';
};

export const DEVELOPMENT_LABEL = { quick: 'Quick', normal: 'Normal', slow: 'Slow' };

export const developmentMultiplier = (development) =>
  development === 'quick' ? 1.25 : development === 'slow' ? 0.78 : 1;

/** Physical learning curve. Young players bank more from every meaningful
 * rep; veterans still learn, but practice is increasingly about maintenance. */
export const ageDevelopmentMultiplier = (age = 26) => {
  if (age <= 22) return 1.38;
  if (age <= 24) return 1.22;
  if (age <= 27) return 1;
  if (age <= 30) return 0.76;
  if (age <= 33) return 0.48;
  return 0.28;
};

/** Each point is harder than the last, particularly once a trait is already
 * NFL-calibre. Shared by weekly work and offseason experience conversion. */
export const traitXpCost = (value) =>
  Math.round(22 + Math.max(0, value - 55) * 0.68 + Math.max(0, value - 82) * 0.9);

export function developmentTrajectory(player) {
  const age = player?.age ?? 26;
  const dev = player?.development || 'normal';
  if (age <= 23) return dev === 'quick' ? 'Rapid ascent' : 'Ascending';
  if (age <= 27) return dev === 'slow' ? 'Gradual growth' : 'Prime development';
  if (age <= 30) return 'Prime plateau';
  if (age <= 33) return 'Maintenance phase';
  return 'Decline risk';
}

/** Keep the latest explainable changes without allowing a long career to
 * bloat a Firestore season document. */
export function withDevelopmentChange(player, change) {
  return {
    ...player,
    developmentHistory: [...(player.developmentHistory || []), change].slice(-16),
  };
}

export function traitValue(player, key) {
  return Number.isFinite(player?.traits?.[key]) ? player.traits[key] : (player?.rating || 75);
}

/** Weighted assignment score, with overall as a safe legacy fallback. */
export function traitScore(player, weights) {
  const entries = Object.entries(weights || {});
  if (!entries.length) return player?.rating || 75;
  const total = entries.reduce((sum, [, weight]) => sum + weight, 0) || 1;
  return entries.reduce((sum, [key, weight]) => sum + traitValue(player, key) * weight, 0) / total;
}

export function visibleTraits(player, limit = 5) {
  const weights = POSITION_TRAITS[player?.pos] || {};
  return Object.keys(weights).sort((a, b) => weights[b] - weights[a]).slice(0, limit)
    .map((key) => ({ key, label: TRAITS[key], value: traitValue(player, key) }));
}

/** 0–99 to a letter, shared by scouting and the roster. */
export function grade(v) {
  if (v >= 93) return 'A+'; if (v >= 87) return 'A'; if (v >= 82) return 'A-';
  if (v >= 78) return 'B+'; if (v >= 73) return 'B'; if (v >= 68) return 'B-';
  if (v >= 64) return 'C+'; if (v >= 58) return 'C'; if (v >= 53) return 'C-';
  if (v >= 48) return 'D+'; if (v >= 42) return 'D'; return 'F';
}
