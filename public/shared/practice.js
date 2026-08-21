// practice.js — three periods of coordinator-owned work each game week.
//
// Drills create a temporary game-week boost and bank development experience
// toward permanent trait growth. Play periods create familiarity with one
// exact call. All mutations are pure so the server can validate the same rules
// the local season uses.
import { OFF_BY_ID, DEF_BY_ID } from './playbook.js';
import {
  ageDevelopmentMultiplier, developmentMultiplier, ratingFromTraits,
  traitXpCost, withDevelopmentChange,
} from './ratings.js';
import { teamStrength } from './roster.js';

export const PRACTICE_PERIODS = 3;
export const DRILL_BOOSTS = [3, 2, 1];
export const DRILL_XP = [4, 3, 2];

const drill = (id, seat, group, positions, trait, label, description) =>
  ({ id, seat, group, positions, trait, label, description });

export const PRACTICE_DRILLS = [
  drill('qb-accuracy', 'OC', 'QB', ['QB'], 'acc', 'Timing throws', 'Improves quarterback accuracy.'),
  drill('qb-arm', 'OC', 'QB', ['QB'], 'arm', 'Deep-ball period', 'Improves arm talent on vertical concepts.'),
  drill('qb-poise', 'OC', 'QB', ['QB'], 'poise', 'Pressure movement', 'Improves pocket poise against pressure.'),
  drill('rb-agility', 'OC', 'RB', ['RB'], 'agility', 'Open-field cuts', 'Improves change of direction for backs.'),
  drill('rb-power', 'OC', 'RB', ['RB'], 'power', 'Contact balance', 'Improves power on interior runs.'),
  drill('rb-hands', 'OC', 'RB', ['RB'], 'hands', 'Backfield receiving', 'Improves receiving reliability for backs.'),
  drill('wr-route', 'OC', 'WR', ['WR'], 'route', 'Route detail', 'Improves separation on breaking routes.'),
  drill('wr-release', 'OC', 'WR', ['WR'], 'release', 'Release circuit', 'Improves releases against press coverage.'),
  drill('wr-hands', 'OC', 'WR', ['WR'], 'hands', 'Catch circuit', 'Improves finishing at the catch point.'),
  drill('te-route', 'OC', 'TE', ['TE'], 'route', 'Tight-end routes', 'Improves route detail for tight ends.'),
  drill('te-block', 'OC', 'TE', ['TE'], 'block', 'Edge blocking', 'Improves tight-end blocking.'),
  drill('te-hands', 'OC', 'TE', ['TE'], 'hands', 'Contested catches', 'Improves tight-end hands.'),
  drill('ol-block', 'OC', 'OL', ['OL'], 'block', 'Run fits', 'Improves base blocking technique.'),
  drill('ol-anchor', 'OC', 'OL', ['OL'], 'anchor', 'Blitz pickup', 'Improves the line’s pass-protection anchor.'),
  drill('ol-pull', 'OC', 'OL', ['OL'], 'pull', 'Movement period', 'Improves mobility on perimeter schemes.'),

  drill('edge-rush', 'DC', 'EDGE', ['EDGE'], 'rush', 'Pass-rush plan', 'Improves pass-rush technique.'),
  drill('edge-burst', 'DC', 'EDGE', ['EDGE'], 'burst', 'Get-off drill', 'Improves burst off the line.'),
  drill('edge-shed', 'DC', 'EDGE', ['EDGE'], 'shed', 'Set the edge', 'Improves block shedding.'),
  drill('dt-power', 'DC', 'DT', ['DT'], 'power', 'Interior power', 'Improves power through contact.'),
  drill('dt-shed', 'DC', 'DT', ['DT'], 'shed', 'Block destruction', 'Improves interior block shedding.'),
  drill('dt-anchor', 'DC', 'DT', ['DT'], 'anchor', 'Double-team anchor', 'Improves resistance to interior movement.'),
  drill('lb-tackle', 'DC', 'LB', ['LB'], 'tackle', 'Tackling circuit', 'Improves finishing in space.'),
  drill('lb-instinct', 'DC', 'LB', ['LB'], 'instinct', 'Run-key reads', 'Improves recognition and reaction.'),
  drill('lb-cover', 'DC', 'LB', ['LB'], 'cover', 'Match coverage', 'Improves coverage technique.'),
  drill('cb-cover', 'DC', 'CB', ['CB', 'NB'], 'cover', 'Coverage technique', 'Improves man and zone coverage.'),
  drill('cb-press', 'DC', 'CB', ['CB', 'NB'], 'press', 'Press period', 'Improves disruption at the line.'),
  drill('cb-agility', 'DC', 'CB', ['CB', 'NB'], 'agility', 'Transition drill', 'Improves change of direction.'),
  drill('s-range', 'DC', 'S', ['S'], 'range', 'Deep-field range', 'Improves ground covered from depth.'),
  drill('s-instinct', 'DC', 'S', ['S'], 'instinct', 'Route recognition', 'Improves pattern recognition.'),
  drill('s-tackle', 'DC', 'S', ['S'], 'tackle', 'Alley tackling', 'Improves run-support tackling.'),
];

export const DRILL_BY_ID = Object.fromEntries(PRACTICE_DRILLS.map((d) => [d.id, d]));

const currentKey = (season) => `${season.year}:${season.week}`;
const freshPractice = (season) => ({ key: currentKey(season), plans: { OC: [], DC: [] } });

export function weeklyPractice(season) {
  return season.practice?.key === currentKey(season) ? season.practice : freshPractice(season);
}

export const practicePlan = (season, seat) => weeklyPractice(season).plans?.[seat] || [];
export const practiceRemaining = (season, seat) =>
  Math.max(0, PRACTICE_PERIODS - practicePlan(season, seat).length);

export const practiceLocked = (season) => (season.results || []).some((r) =>
  r.week === season.week && (r.home === season.userTeam || r.away === season.userTeam));

function repeatIndex(plan, selection) {
  return plan.filter((p) => p.type === selection.type
    && (p.drillId || p.callId) === (selection.drillId || selection.callId)).length;
}

function trainGroup(roster, drillDef, rep, season) {
  const side = drillDef.seat === 'OC' ? 'offense' : 'defense';
  const gain = (DRILL_XP[rep] || 1);
  const improvements = [];
  const list = roster[side].map((player) => {
    if (!drillDef.positions.includes(player.pos)
      || !Number.isFinite(player.traits?.[drillDef.trait])) return player;
    const trainingXp = { ...(player.trainingXp || {}) };
    const practiceLoad = { ...(player.practiceLoad || {}) };
    let value = player.traits[drillDef.trait];
    let xp = (trainingXp[drillDef.trait] || 0) + gain
      * developmentMultiplier(player.development)
      * ageDevelopmentMultiplier(player.age);
    practiceLoad[drillDef.trait] = +(practiceLoad[drillDef.trait] || 0) + gain;
    const from = value;
    while (value < 99 && xp >= traitXpCost(value)) {
      xp -= traitXpCost(value);
      value++;
      improvements.push({ name: player.name, pos: player.pos, trait: drillDef.trait, value });
    }
    trainingXp[drillDef.trait] = +xp.toFixed(2);
    const traits = { ...player.traits, [drillDef.trait]: value };
    let next = { ...player, traits, trainingXp, practiceLoad,
      rating: ratingFromTraits(player.pos, traits, player.rating) };
    if (value !== from) next = withDevelopmentChange(next, {
      year: season.year, week: season.week, source: 'practice', trait: drillDef.trait,
      from, to: value,
    });
    return next;
  });
  return { roster: { ...roster, [side]: list }, improvements };
}

function validateSelection(season, seat, selection) {
  if (!['OC', 'DC'].includes(seat)) throw new Error('A coordinator seat is required.');
  if (!['regular', 'playoffs'].includes(season.phase)) throw new Error('Practice is available during game weeks.');
  if (practiceLocked(season)) throw new Error('Practice is locked after this week’s game.');
  const plan = practicePlan(season, seat);
  if (plan.length >= PRACTICE_PERIODS) throw new Error('All three practice periods are assigned.');
  if (selection?.type === 'drill') {
    const d = DRILL_BY_ID[selection.drillId];
    if (!d || d.seat !== seat) throw new Error('That drill does not belong to your unit.');
    return { type: 'drill', drillId: d.id };
  }
  if (selection?.type === 'play') {
    const call = seat === 'OC' ? OFF_BY_ID[selection.callId] : DEF_BY_ID[selection.callId];
    const installed = seat === 'OC' ? season.customPlays : season.customDefenses;
    if (!call || (call.custom && !(installed || []).some((p) => p.id === call.id))) {
      throw new Error('That play is not installed.');
    }
    return { type: 'play', callId: call.id };
  }
  throw new Error('Choose a drill or a play period.');
}

export function addPracticePeriod(season, seat, selection) {
  const clean = validateSelection(season, seat, selection);
  const practice = weeklyPractice(season);
  const plan = practice.plans[seat] || [];
  const rep = repeatIndex(plan, clean);
  let rosters = season.rosters, improvements = [];
  if (clean.type === 'drill') {
    const trained = trainGroup(
      season.rosters[season.userTeam], DRILL_BY_ID[clean.drillId], rep, season);
    rosters = { ...season.rosters, [season.userTeam]: trained.roster };
    improvements = trained.improvements;
  }
  return {
    season: {
      ...season,
      rosters,
      strength: rosters === season.rosters ? season.strength : {
        ...season.strength,
        [season.userTeam]: teamStrength(rosters[season.userTeam]),
      },
      practice: { ...practice, plans: { ...practice.plans, [seat]: [...plan, clean] } },
    },
    improvements,
    remaining: PRACTICE_PERIODS - plan.length - 1,
  };
}

export function practiceEffects(season, seat) {
  const plan = practicePlan(season, seat);
  const traitBoosts = {}, plays = {}, playReps = {};
  for (let i = 0; i < plan.length; i++) {
    const item = plan[i], rep = repeatIndex(plan.slice(0, i), item);
    if (item.type === 'drill') {
      const d = DRILL_BY_ID[item.drillId];
      if (!d) continue;
      for (const pos of d.positions) {
        traitBoosts[pos] = traitBoosts[pos] || {};
        traitBoosts[pos][d.trait] = (traitBoosts[pos][d.trait] || 0) + (DRILL_BOOSTS[rep] || 1);
      }
    } else if (item.type === 'play') {
      const call = seat === 'OC' ? OFF_BY_ID[item.callId] : DEF_BY_ID[item.callId];
      if (!call) continue;
      const scale = call.custom ? [0.026, 0.017, 0.010] : [0.020, 0.012, 0.007];
      plays[item.callId] = (plays[item.callId] || 0) + (scale[rep] || 0.005);
      playReps[item.callId] = (playReps[item.callId] || 0) + 1;
    }
  }
  return { traitBoosts, plays, playReps };
}

function boostSide(list, boosts) {
  return list.map((player) => {
    const add = boosts[player.pos];
    if (!add || !player.traits) return player;
    const traits = { ...player.traits };
    for (const [key, value] of Object.entries(add)) {
      if (Number.isFinite(traits[key])) traits[key] = Math.min(99, traits[key] + value);
    }
    return { ...player, traits, rating: ratingFromTraits(player.pos, traits, player.rating) };
  });
}

/** A temporary copy for this game. Permanent roster ratings remain untouched. */
export function practicedRoster(season) {
  const roster = season.rosters[season.userTeam];
  if (!roster) return roster;
  return {
    offense: boostSide(roster.offense, practiceEffects(season, 'OC').traitBoosts),
    defense: boostSide(roster.defense, practiceEffects(season, 'DC').traitBoosts),
  };
}

/** Team strength for fast simulation, including a modest expected-value bonus
 * for rehearsed calls. Live games apply the larger bonus only when that exact
 * call is selected; the simulator does not model every individual call. */
export function practicedStrength(season) {
  const strength = teamStrength(practicedRoster(season));
  const callBonus = (seat) => Object.values(practiceEffects(season, seat).plays)
    .reduce((total, edge) => total + edge, 0) * 8;
  return {
    off: strength.off + callBonus('OC'),
    def: strength.def + callBonus('DC'),
  };
}

export function practiceLabel(item) {
  if (item.type === 'drill') return DRILL_BY_ID[item.drillId]?.label || item.drillId;
  return OFF_BY_ID[item.callId]?.name || DEF_BY_ID[item.callId]?.name || item.callId;
}
