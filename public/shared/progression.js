// progression.js — turn a player's game tape into targeted development.
//
// Practice teaches a chosen skill. Games are less controlled: they award a
// small amount for real snaps and more when the box score demonstrates that a
// particular skill succeeded. The same age curve, development rate and rising
// trait costs used by practice still decide when XP becomes a rating point.
import { OFF_SPOTS, DEF_SPOTS, teamStrength } from './roster.js';
import {
  ageDevelopmentMultiplier, developmentMultiplier, ratingFromTraits,
  traitXpCost, withDevelopmentChange,
} from './ratings.js';

const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
// A full season of solid starter production should usually move one or two
// relevant traits, not merely fill an invisible bar for several years.
const PERFORMANCE_XP_SCALE = 2.25;
const OFF_STARTERS = new Set(OFF_SPOTS.filter((s) => s.key).map((s) => s.id));
const DEF_STARTERS = new Set(DEF_SPOTS.filter((s) => s.key).map((s) => s.id));

function put(out, trait, xp, reason) {
  if (!Number.isFinite(xp) || xp < 0.05) return;
  const current = out[trait] || { xp: 0, reason };
  current.xp = clamp(current.xp + xp, 0, 5.5);
  if (!current.reason) current.reason = reason;
  out[trait] = current;
}

const ratio = (a, b) => b > 0 ? a / b : 0;

function offensiveAwards(player, line = {}, team = {}) {
  const out = {};
  const starter = OFF_STARTERS.has(player.spot);
  const touches = (line.att || 0) + (line.carries || 0) + (line.targets || 0);
  const participated = starter || touches > 0;
  if (!participated) return out;

  if (player.pos === 'QB') {
    const att = line.att || 0, pct = ratio(line.comp || 0, att), ypa = ratio(line.passYards || 0, att);
    const reps = att ? `${Math.round(pct * 100)}% completions` : 'game reps';
    put(out, 'acc', .18 + Math.max(0, pct - .58) * 9 + (line.comp || 0) * .018,
      reps);
    put(out, 'field', .15 + (line.passTD || 0) * .68 + Math.max(0, ypa - 6) * .2
      - (line.int || 0) * .28, `${line.passTD || 0} TD, ${line.int || 0} INT`);
    put(out, 'poise', .14 + (line.passTD || 0) * .32 + Math.max(0, att - 15) * .018
      - (line.sacked || 0) * .1, `${line.sacked || 0} sacks taken`);
    put(out, 'arm', .1 + Math.max(0, ypa - 6.5) * .28 + (line.passTD || 0) * .12,
      `${ypa.toFixed(1)} yards per attempt`);
  } else if (player.pos === 'RB') {
    const carries = line.carries || 0, ypc = ratio(line.rushYards || 0, carries);
    const catchRate = ratio(line.rec || 0, line.targets || 0);
    put(out, 'agility', .14 + carries * .025 + Math.max(0, ypc - 3.7) * .42,
      carries ? `${ypc.toFixed(1)} yards per carry` : 'game reps');
    put(out, 'burst', .12 + Math.max(0, (line.rushLong || 0) - 9) * .045
      + Math.max(0, ypc - 4.2) * .28, `${line.rushLong || 0}-yard long run`);
    put(out, 'power', .12 + carries * .018 + (line.rushTD || 0) * .58,
      `${carries} carries, ${line.rushTD || 0} TD`);
    put(out, 'hands', (line.targets || 0) * .045 + (line.rec || 0) * .07
      + Math.max(0, catchRate - .6) * .55, `${line.rec || 0}/${line.targets || 0} receiving`);
  } else if (player.pos === 'WR' || player.pos === 'TE') {
    const targets = line.targets || 0, rec = line.rec || 0;
    const catchRate = ratio(rec, targets), ypt = ratio(line.recYards || 0, targets);
    put(out, 'hands', .1 + rec * .075 + Math.max(0, catchRate - .55) * 1.15,
      targets ? `${rec}/${targets} catches` : 'game reps');
    put(out, 'route', .12 + targets * .04 + Math.max(0, ypt - 5.5) * .22,
      targets ? `${ypt.toFixed(1)} yards per target` : 'game reps');
    put(out, player.pos === 'TE' ? 'block' : 'release', .1 + (line.recTD || 0) * .48
      + Math.max(0, targets - 4) * .035, `${line.recTD || 0} receiving TD`);
    put(out, 'speed', Math.max(0, (line.recLong || 0) - 14) * .035,
      `${line.recLong || 0}-yard long reception`);
    if (player.pos === 'WR') put(out, 'burst', Math.max(0, (line.recLong || 0) - 10) * .025,
      `${line.recLong || 0}-yard long reception`);
  } else if (player.pos === 'OL') {
    const teamCarries = team.carries || 0;
    const ypc = ratio(team.rushYards || 0, teamCarries);
    put(out, 'block', .24 + Math.max(0, ypc - 3.5) * .34, `${ypc.toFixed(1)} team rush average`);
    put(out, 'anchor', .22 + Math.max(0, 3 - (team.sacksAllowed || 0)) * .16,
      `${team.sacksAllowed || 0} sacks allowed`);
    put(out, 'motor', .12 + Math.min(70, team.plays || 0) * .004, `${team.plays || 0} offensive plays`);
  }
  return out;
}

function defensiveAwards(player, line = {}, opponent = {}) {
  const out = {};
  const starter = DEF_STARTERS.has(player.spot);
  const events = (line.tackles || 0) + (line.sacks || 0) + (line.pbu || 0)
    + (line.ints || 0) + (line.ffum || 0);
  if (!starter && !events) return out;
  const tackles = line.tackles || 0, sacks = line.sacks || 0;
  const pbu = line.pbu || 0, ints = line.ints || 0, ffum = line.ffum || 0;
  const passYpp = ratio(opponent.passYards || 0, opponent.plays || 0);
  const reps = events ? null : 'game reps';

  if (player.pos === 'EDGE') {
    put(out, 'rush', .16 + sacks * 1.35 + ffum * .75, reps || `${sacks} sacks, ${ffum} forced fumbles`);
    put(out, 'burst', .1 + sacks * .58, reps || `${sacks} sacks`);
    put(out, 'shed', .12 + tackles * .12, reps || `${tackles} tackles`);
    put(out, 'motor', .1 + tackles * .06 + sacks * .18, `${tackles} tackles`);
  } else if (player.pos === 'DT') {
    put(out, 'power', .15 + sacks * .9 + tackles * .07, `${sacks} sacks, ${tackles} tackles`);
    put(out, 'shed', .15 + tackles * .14 + sacks * .48, `${tackles} tackles`);
    put(out, 'anchor', .12 + Math.max(0, 5 - ratio(opponent.rushYards || 0,
      opponent.plays || 0)) * .12, `${opponent.rushYards || 0} opponent rush yards`);
  } else if (player.pos === 'LB') {
    put(out, 'tackle', .14 + tackles * .13 + ffum * .52, `${tackles} tackles`);
    put(out, 'instinct', .14 + tackles * .065 + ints * 1.25 + sacks * .38,
      `${ints} INT, ${sacks} sacks`);
    put(out, 'cover', .1 + pbu * .62 + ints * .88, `${pbu} breakups, ${ints} INT`);
    put(out, 'shed', .08 + sacks * .35, `${sacks} sacks`);
  } else if (player.pos === 'CB' || player.pos === 'NB') {
    put(out, 'cover', .15 + pbu * .78 + ints * 1.45 + Math.max(0, 6.2 - passYpp) * .12,
      reps || `${pbu} breakups, ${ints} INT`);
    put(out, 'instinct', .12 + ints * 1.18 + pbu * .28, `${ints} INT`);
    put(out, 'press', .08 + pbu * .34 + tackles * .035, `${pbu} breakups`);
    put(out, 'agility', .08 + pbu * .26, `${pbu} breakups`);
    put(out, 'tackle', tackles * .08, `${tackles} tackles`);
  } else if (player.pos === 'S') {
    put(out, 'range', .15 + ints * 1.28 + pbu * .52 + Math.max(0, 6.2 - passYpp) * .1,
      reps || `${ints} INT, ${pbu} breakups`);
    put(out, 'instinct', .14 + ints * 1.05 + pbu * .3 + tackles * .035, `${tackles} tackles`);
    put(out, 'tackle', .12 + tackles * .12 + ffum * .52, `${tackles} tackles`);
    put(out, 'cover', .1 + pbu * .4 + ints * .72, `${pbu} breakups`);
  }
  return out;
}

function teamContext(result, home) {
  const ours = home ? result.homeStats : result.awayStats;
  const opponent = home ? result.awayStats : result.homeStats;
  const offense = result.players?.offense || [];
  return {
    ours: {
      ...ours,
      carries: offense.reduce((n, p) => n + (p.carries || 0), 0),
      sacksAllowed: offense.reduce((n, p) => n + (p.sacked || 0), 0),
    },
    opponent,
  };
}

function developPlayer(player, awards, season, result) {
  if (!player.traits || !Object.keys(awards).length) {
    return { player, total: 0, improvements: [], earned: [] };
  }
  const rate = PERFORMANCE_XP_SCALE * ageDevelopmentMultiplier(player.age)
    * developmentMultiplier(player.development);
  const trainingXp = { ...(player.trainingXp || {}) };
  const traits = { ...player.traits };
  const earned = [];
  const improvements = [];
  let next = player;
  for (const [trait, award] of Object.entries(awards)) {
    if (!Number.isFinite(traits[trait])) continue;
    const xpEarned = +(award.xp * rate).toFixed(2);
    if (xpEarned <= 0) continue;
    const from = traits[trait];
    let value = from;
    let xp = (trainingXp[trait] || 0) + xpEarned;
    while (value < 99 && xp >= traitXpCost(value)) {
      xp -= traitXpCost(value);
      value++;
    }
    traits[trait] = value;
    trainingXp[trait] = +xp.toFixed(2);
    earned.push({ trait, xp: xpEarned, reason: award.reason });
    if (value !== from) {
      improvements.push({ name: player.name, pos: player.pos, trait, from, to: value });
      next = withDevelopmentChange(next, {
        year: season.year, week: result.week, source: 'game', trait, from, to: value,
        reason: award.reason,
      });
    }
  }
  const performanceHistory = [...(next.performanceHistory || []), {
    year: season.year, week: result.week, gameId: result.id,
    awards: earned,
  }].slice(-6);
  return {
    player: { ...next, traits, trainingXp, performanceHistory,
      rating: ratingFromTraits(player.pos, traits, player.rating) },
    total: earned.reduce((n, a) => n + a.xp, 0),
    improvements,
    earned,
  };
}

/** Apply one completed user-team game exactly once. Returns a replacement
 * result carrying the idempotency marker so retries cannot award XP twice. */
export function applyGamePerformanceDevelopment(season, result) {
  const relevant = result?.final && (result.home === season.userTeam || result.away === season.userTeam);
  if (!relevant || result.performanceDevelopmentApplied) {
    return { season, result, awards: [], improvements: [] };
  }
  const roster = season.rosters?.[season.userTeam];
  if (!roster) return { season, result: { ...result, performanceDevelopmentApplied: true },
    awards: [], improvements: [] };
  const home = result.home === season.userTeam;
  const context = teamContext(result, home);
  const summaries = [], improvements = [];
  const step = (side) => roster[side].map((player) => {
    const line = (result.players?.[side] || []).find((p) => p.name === player.name) || {};
    const raw = side === 'offense'
      ? offensiveAwards(player, line, context.ours)
      : defensiveAwards(player, line, context.opponent);
    const developed = developPlayer(player, raw, season, result);
    if (developed.total >= .05) summaries.push({
      name: player.name, pos: player.pos, xp: +developed.total.toFixed(2),
      traits: developed.earned.map((x) => x.trait),
      improved: developed.improvements.map((x) => x.trait),
    });
    improvements.push(...developed.improvements);
    return developed.player;
  });
  const nextRoster = { offense: step('offense'), defense: step('defense') };
  const awards = summaries.sort((a, b) => b.xp - a.xp);
  return {
    season: {
      ...season,
      rosters: { ...season.rosters, [season.userTeam]: nextRoster },
      strength: { ...season.strength, [season.userTeam]: teamStrength(nextRoster) },
      lastGameDevelopment: {
        year: season.year, week: result.week, gameId: result.id,
        awards: awards.slice(0, 10), improvements,
      },
    },
    result: { ...result, performanceDevelopmentApplied: true },
    awards,
    improvements,
  };
}
