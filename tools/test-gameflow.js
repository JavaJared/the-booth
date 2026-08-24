import assert from 'node:assert/strict';
import {
  computeEdge, resolveSnap, newGameState, emptyTendencies, mulberry32, hashSeed,
} from '../public/shared/engine.js';
import { runToNextDecision } from '../public/shared/gameflow.js';
import {
  OFFENSE, DEFENSE, OFF_BY_ID, DEF_BY_ID, registerCustomPlays, registerCustomDefenses,
  registerSeasonCalls, seasonCallIds,
} from '../public/shared/playbook.js';
import { derivePlay, deriveDefense, setManAssignment } from '../public/shared/designer.js';
import { spatialMatchup } from '../public/shared/spatial.js';
import { INVITE_ALPHABET, inviteCode, normalizeInviteCode } from '../public/shared/codes.js';
import {
  createSeason,
  dehydrate,
  hydrate,
  liveConfig,
  finishedGameRecorded,
  recordGameFilm,
  nextSeason,
  simRemainingWeek,
  shouldEnterSeasonLobby,
  startOffseason,
  unlockFilmOverlay,
} from '../public/shared/season.js';
import { TEAMS } from '../public/shared/league.js';
import {
  DEF_SPOTS, assignmentTraits, coverDefender, offensivePlayFit, talentMatchup,
} from '../public/shared/roster.js';
import {
  ageDevelopmentMultiplier, developmentTrajectory, ratingFromTraits, traitScore, traitXpCost,
} from '../public/shared/ratings.js';
import { addToRoster, ageRoster, makeClass } from '../public/shared/draft.js';
import { depthChart } from '../public/shared/depth.js';
import {
  FILM_OVERLAY_COST, filmRows, opponentDiagram, opponentDefenseDiagram,
} from '../public/shared/film.js';
import {
  addPracticePeriod, practiceEffects, practiceLocked, practicePlan,
  practiceRemaining, practicedRoster, practicedStrength,
} from '../public/shared/practice.js';
import { talentFeedback } from '../public/shared/feedback.js';

const fixedInvite = inviteCode(Uint8Array.from([0, 1, 31, 32]));
assert.equal(fixedInvite, `AB${INVITE_ALPHABET[31]}A`,
  'invitation codes should contain exactly four unambiguous characters');
assert.match(fixedInvite, /^[A-HJ-NP-Z2-9]{4}$/,
  'invitation codes should exclude characters commonly confused in handwriting');
assert.equal(normalizeInviteCode(' ab2z '), 'AB2Z',
  'new four-character invitation codes should be case-insensitive');
assert.equal(normalizeInviteCode('Wp2NXrknSaTLRVATd12d'), 'Wp2NXrknSaTLRVATd12d',
  'legacy Firestore invitation ids must retain their case exactly');

const oneCallerLobby = { currentGameId: 'GAME', vote: { OC: 'call', DC: null } };
assert.equal(shouldEnterSeasonLobby(oneCallerLobby, 'OC'), true,
  'the coordinator who calls the game should enter its lobby');
assert.equal(shouldEnterSeasonLobby(oneCallerLobby, 'DC'), false,
  'one coordinator calling must not pull the other coordinator into the lobby');
assert.equal(shouldEnterSeasonLobby(oneCallerLobby, 'OC', 'GAME'), false,
  'a coordinator who backs out should stay on the season screen');

const soloLobby = {
  currentGameId: 'SOLO',
  seats: { OC: { uid: 'solo-coach' } },
  vote: { OC: null, DC: null },
};
assert.equal(shouldEnterSeasonLobby(soloLobby, 'OC'), true,
  'a solo coordinator should enter an active game even if an old vote is missing');
assert.equal(shouldEnterSeasonLobby(soloLobby, 'OC', 'SOLO'), false,
  'a solo coordinator can still back out of the lobby');

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
const allPlayers = Object.values(statSeason.rosters)
  .flatMap((r) => [...r.offense, ...r.defense]);
const profiledPlayers = allPlayers.filter((p) => p.traits);
assert.ok(profiledPlayers.length > 1500,
  'every non-specialist in the league should receive a position trait profile');
assert.ok(profiledPlayers.every((p) =>
  Math.abs(p.rating - ratingFromTraits(p.pos, p.traits, p.rating)) <= 1),
'position traits should preserve the player\'s established overall quality');

// A complete legacy save used to return before roster migrations ran. Traits
// must be added even when the old document already carries its schedule.
const legacyRatingsSave = structuredClone(statSeason);
const legacyPlayer = legacyRatingsSave.rosters[legacyRatingsSave.userTeam].offense[0];
const legacyIdentity = { name: legacyPlayer.name, rating: legacyPlayer.rating };
delete legacyPlayer.traits;
delete legacyPlayer.development;
const migratedRatings = hydrate(legacyRatingsSave);
const migratedPlayer = migratedRatings.rosters[migratedRatings.userTeam].offense[0];
assert.deepEqual({ name: migratedPlayer.name, rating: migratedPlayer.rating }, legacyIdentity,
  'rating migration should never replace or reroll an existing player');
assert.ok(migratedPlayer.traits && migratedPlayer.development,
  'a complete legacy save should receive traits and a development rate');

// Draft scouting already knew the prospect's individual traits. Making the
// roster must retain that identity instead of collapsing him into one number.
const prospect = makeClass('ratings-draft', 2027)[0];
const rosterForProspect = structuredClone(statSeason.rosters[statSeason.userTeam]);
const positionPlayers = rosterForProspect[prospect.side].filter((p) => p.pos === prospect.pos);
positionPlayers.forEach((p) => { p.rating = Math.min(p.rating, 40); });
const signedProspect = addToRoster(rosterForProspect, { ...prospect, rating: 99 });
const rosterProspect = signedProspect.roster[prospect.side].find((p) => p.name === prospect.name);
assert.deepEqual(rosterProspect.traits,
  Object.fromEntries(Object.keys(rosterProspect.traits).map((key) => [key, prospect.traits[key]])),
  'a drafted player should carry his scouted position traits onto the roster');

// Progression moves individual abilities, then derives overall from them.
const youngRoster = { offense: [{
  spot: 'QB', pos: 'QB', name: 'Progression Fixture', rating: 75, age: 21,
  traits: { arm: 78, acc: 72, poise: 75, field: 76 }, development: 'quick',
  trainingXp: { acc: traitXpCost(72) - 1 },
}], defense: [] };
const agedPlayer = ageRoster(youngRoster, 'ratings-age', 2027, {
  _teamGames: 17, 'Progression Fixture': { games: 17, att: 500 },
}).offense[0];
assert.notDeepEqual(agedPlayer.traits, youngRoster.offense[0].traits,
  'annual development should move individual attributes rather than only overall');
assert.equal(agedPlayer.rating, ratingFromTraits(agedPlayer.pos, agedPlayer.traits, 75),
  'post-development overall should be derived from the updated traits');
assert.ok(agedPlayer.developmentHistory.some((c) => c.trait === 'acc' && c.to > c.from),
  'offseason gains should retain an explainable per-trait history');
assert.ok(ageDevelopmentMultiplier(21) > ageDevelopmentMultiplier(30)
  && ageDevelopmentMultiplier(30) > ageDevelopmentMultiplier(35),
'development speed should decrease across the player aging curve');
assert.ok(traitXpCost(92) > traitXpCost(72),
  'elite traits should require more experience to raise than average traits');
assert.equal(developmentTrajectory({ age: 22, development: 'quick' }), 'Rapid ascent',
  'the roster trajectory should explain a young quick developer');

const experienceFixture = { offense: [{
  spot: 'WR1', pos: 'WR', name: 'Experience Fixture', rating: 75, age: 24,
  traits: { speed: 75, hands: 75, route: 75, release: 75, burst: 75 },
  development: 'normal',
}], defense: [] };
const idleExperience = ageRoster(experienceFixture, 'playing-time-xp', 2027, {
  _teamGames: 0,
}).offense[0];
const starterExperience = ageRoster(experienceFixture, 'playing-time-xp', 2027, {
  _teamGames: 17, 'Experience Fixture': { games: 17, targets: 120 },
}).offense[0];
assert.ok(starterExperience.trainingXp.route > idleExperience.trainingXp.route,
  'real playing time should bank more role-specific experience than a season without appearances');
assert.ok(starterExperience.trainingXp.route > starterExperience.trainingXp.speed,
  'playing experience should emphasize assignment skills instead of raising every trait evenly');

const veteran = { spot: 'S1', pos: 'S', name: 'Maintenance Fixture', rating: 75, age: 34,
  traits: { range: 75, instinct: 75, tackle: 75, cover: 75, speed: 75 },
  development: 'normal' };
const decliningVeteran = ageRoster({ offense: [], defense: [veteran] }, 'maint', 2027,
  { _teamGames: 17, 'Maintenance Fixture': { games: 17 } }).defense[0];
const maintainedVeteran = ageRoster({ offense: [], defense: [{ ...veteran,
  practiceLoad: { range: 18, instinct: 18, tackle: 18, cover: 18, speed: 18 },
}] }, 'maint', 2027, { _teamGames: 17, 'Maintenance Fixture': { games: 17 } }).defense[0];
assert.ok(Object.keys(veteran.traits).every((key) =>
  maintainedVeteran.traits[key] >= decliningVeteran.traits[key]),
'practice on an older player should mitigate decline on the attributes that were maintained');
assert.ok(maintainedVeteran.developmentHistory.some((c) => c.source === 'maintenance'),
  'prevented veteran decline should be visible in development history');

// Two equally rated receivers should fit different concepts based on how they
// win. Speed matters on verticals; detailed route skill matters on a comeback.
const speedReceiver = { spot: 'WR1', pos: 'WR', name: 'Speed Receiver', rating: 78,
  traits: { speed: 99, hands: 80, route: 65, release: 99, burst: 96 } };
const routeReceiver = { spot: 'WR1', pos: 'WR', name: 'Route Receiver', rating: 78,
  traits: { speed: 45, hands: 95, route: 99, release: 80, burst: 55 } };
assert.ok(traitScore(speedReceiver, assignmentTraits(OFF_BY_ID.verts, speedReceiver))
  > traitScore(routeReceiver, assignmentTraits(OFF_BY_ID.verts, routeReceiver)),
'vertical concepts should prefer the receiver with superior speed and burst');
assert.ok(traitScore(routeReceiver, assignmentTraits(OFF_BY_ID.hitches, routeReceiver))
  > traitScore(speedReceiver, assignmentTraits(OFF_BY_ID.hitches, speedReceiver)),
'breaking routes should prefer the superior route runner');

const fitRoster = structuredClone(statSeason.rosters[statSeason.userTeam].offense);
Object.assign(fitRoster.find((p) => p.spot === 'WR1'), speedReceiver);
const verticalFit = offensivePlayFit(OFF_BY_ID.verts, fitRoster);
assert.ok(verticalFit.rows.find((r) => r.player.spot === 'WR1').score > 80,
  'the play designer should expose assignment fit from the same trait calculation');

const neutralDefense = [{ spot: 'CB1', pos: 'CB', name: 'Neutral Corner', rating: 78,
  traits: { cover: 78, speed: 78, press: 78, instinct: 78, agility: 78 } }];
const qb = { spot: 'QB', pos: 'QB', name: 'Neutral QB', rating: 75,
  traits: { arm: 75, acc: 75, poise: 75, field: 75 } };
const ol = { spot: 'OL', pos: 'OL', name: 'Neutral Line', rating: 75,
  traits: { block: 75, anchor: 75, pull: 75, frame: 75, motor: 75 } };
const edge = { spot: 'EDGE1', pos: 'EDGE', name: 'Neutral Edge', rating: 75,
  traits: { rush: 75, burst: 75, shed: 75, motor: 75, frame: 75 } };
const fastDeepEdge = talentMatchup(OFF_BY_ID.verts, DEF_BY_ID.nick1, speedReceiver,
  neutralDefense[0], [qb, ol, speedReceiver], neutralDefense, edge).edge;
const technicianDeepEdge = talentMatchup(OFF_BY_ID.verts, DEF_BY_ID.nick1, routeReceiver,
  neutralDefense[0], [qb, ol, routeReceiver], neutralDefense, edge).edge;
assert.ok(fastDeepEdge > technicianDeepEdge,
  'live snap talent should reward the player whose specific traits fit the assignment');
const traitTestPlay = { ...OFF_BY_ID.verts, id: 'trait-test-verticals', custom: true,
  targets: { WR1: 100 } };
registerCustomPlays([traitTestPlay]);
const traitGameRosters = statSeason.rosters[statSeason.userTeam];
const snapsFor = (receiver) => {
  const offense = structuredClone(traitGameRosters.offense);
  Object.assign(offense.find((p) => p.spot === 'WR1'), receiver);
  let completions = 0, matchup = null;
  for (let i = 0; i < 3000; i++) {
    const out = resolveSnap(newGameState({ firstPossession: 'US' }), traitTestPlay.id, 'nick1',
      mulberry32(hashSeed(`trait-snap:${i}`)), emptyTendencies(), {
        offRoster: offense, defRoster: statSeason.rosters[TEAMS[1].id].defense,
      });
    if (out.complete) completions++;
    matchup = out.playerMatchup;
  }
  return { completions, matchup };
};
const fastSnaps = snapsFor(speedReceiver), routeSnaps = snapsFor(routeReceiver);
assert.ok(fastSnaps.completions > routeSnaps.completions + 20,
  'assignment-specific traits should create a measurable live completion advantage');
assert.equal(fastSnaps.matchup.label, 'Deep-route execution',
  'snap outcomes should explain which player assignment was evaluated');
assert.ok(fastSnaps.matchup.decisive?.offense?.key
  && fastSnaps.matchup.decisive?.defense?.key,
'snap outcomes should retain the exact opposing traits used by post-play feedback');

const pressFeedbackPlay = {
  offId: 'slants', defId: 'simpress', down: 1, distance: 10,
  events: [{ type: 'score' }],
};
const pressMatchup = {
  offense: { player: 'Marcus Bell' }, defense: { player: 'Darius Cole' },
  decisive: {
    offense: { key: 'release', label: 'Release', value: 72 },
    defense: { key: 'press', label: 'Press', value: 91 },
  },
};
const touchdownFeedback = talentFeedback(pressFeedbackPlay, {
  playerMatchup: pressMatchup, complete: true, yards: 40,
});
assert.ok(touchdownFeedback.some((line) => /advantage, but .* still won the matchup for the touchdown/i.test(line)),
  'a touchdown must explain that the receiver overcame a stronger press matchup');
assert.equal(touchdownFeedback.some((line) => /took away/i.test(line)), false,
  'the feed must not claim press took away the release on a completed touchdown');
const incompleteFeedback = talentFeedback({ ...pressFeedbackPlay, events: [] }, {
  playerMatchup: pressMatchup, complete: false, yards: 0,
});
assert.ok(incompleteFeedback.some((line) => /took away/i.test(line)),
  'the direct defensive-win message remains appropriate when the pass is incomplete');
assert.deepEqual(talentFeedback(pressFeedbackPlay, {
  playerMatchup: pressMatchup, complete: true, yards: 40,
  penalty: { id: 'hold', replay: true },
}), [], 'a wiped-out play must not receive player matchup feedback');

// Weekly practice belongs to one coordinator, carries three periods, and has
// diminishing returns when the same work is repeated.
let practiceSeason = createSeason({ seed: 'weekly-practice', userTeam: TEAMS[0].id });
const permanentWr = practiceSeason.rosters[practiceSeason.userTeam].offense
  .find((p) => p.spot === 'WR1');
const permanentRoute = permanentWr.traits.route;
practiceSeason = addPracticePeriod(practiceSeason, 'OC',
  { type: 'drill', drillId: 'wr-route' }).season;
assert.equal(practiceRemaining(practiceSeason, 'OC'), 2,
  'a coordinator should begin with three weekly practice periods');
assert.equal(practiceEffects(practiceSeason, 'OC').traitBoosts.WR.route, 3,
  'the first position-drill period should provide its full weekly boost');
practiceSeason = addPracticePeriod(practiceSeason, 'OC',
  { type: 'drill', drillId: 'wr-route' }).season;
assert.equal(practiceEffects(practiceSeason, 'OC').traitBoosts.WR.route, 5,
  'a repeated drill should add a smaller second-period boost');
practiceSeason = addPracticePeriod(practiceSeason, 'OC',
  { type: 'drill', drillId: 'wr-route' }).season;
assert.equal(practiceEffects(practiceSeason, 'OC').traitBoosts.WR.route, 6,
  'a third repeated drill should have the smallest return');
assert.throws(() => addPracticePeriod(practiceSeason, 'OC',
  { type: 'play', callId: 'verts' }), /three practice periods/i,
'a coordinator cannot exceed the weekly period budget');
assert.throws(() => addPracticePeriod(createSeason({ seed: 'wrong-unit', userTeam: TEAMS[0].id }),
  'DC', { type: 'drill', drillId: 'wr-route' }), /your unit/i,
'a defensive coordinator cannot assign an offensive drill');
let agePractice = createSeason({ seed: 'practice-aging-curve', userTeam: TEAMS[0].id });
const agePracticeRoster = structuredClone(agePractice.rosters[agePractice.userTeam]);
const practiceWrs = agePracticeRoster.offense.filter((p) => p.pos === 'WR').slice(0, 2);
for (const [index, p] of practiceWrs.entries()) {
  p.age = index ? 33 : 22;
  p.development = 'normal';
  p.trainingXp = { route: 0 };
  p.traits.route = 72;
}
agePractice.rosters[agePractice.userTeam] = agePracticeRoster;
agePractice = addPracticePeriod(agePractice, 'OC',
  { type: 'drill', drillId: 'wr-route' }).season;
const trainedByName = new Map(agePractice.rosters[agePractice.userTeam].offense
  .filter((p) => practiceWrs.some((wr) => wr.name === p.name)).map((p) => [p.name, p]));
assert.ok(trainedByName.get(practiceWrs[0].name).trainingXp.route
  > trainedByName.get(practiceWrs[1].name).trainingXp.route,
'the same practice period should produce more development XP for a young player than a veteran');
const preparedWr = practicedRoster(practiceSeason).offense.find((p) => p.spot === 'WR1');
assert.equal(preparedWr.traits.route, Math.min(99, permanentRoute + 6),
  'drill ratings should be applied to a temporary game-week roster');
assert.equal(practiceSeason.rosters[practiceSeason.userTeam].offense
  .find((p) => p.spot === 'WR1').traits.route, permanentRoute,
'the temporary weekly boost must not overwrite the permanent rating');
assert.equal(practicePlan({ ...practiceSeason, week: practiceSeason.week + 1 }, 'OC').length, 0,
  'weekly practice effects should expire when the calendar advances');

// Repeated weekly work banks development XP and eventually raises the actual
// trait, with overall recalculated from the new profile.
let developmentSeason = createSeason({ seed: 'practice-development', userTeam: TEAMS[0].id });
const developmentBefore = new Map(developmentSeason.rosters[developmentSeason.userTeam].offense
  .filter((p) => p.pos === 'WR').map((p) => [p.name, p.traits.route]));
for (let week = 1; week <= 5; week++) {
  developmentSeason = { ...developmentSeason, week };
  for (let period = 0; period < 3; period++) {
    developmentSeason = addPracticePeriod(developmentSeason, 'OC',
      { type: 'drill', drillId: 'wr-route' }).season;
  }
}
const developedWrs = developmentSeason.rosters[developmentSeason.userTeam].offense
  .filter((p) => p.pos === 'WR');
assert.ok(developedWrs.some((p) => p.traits.route > developmentBefore.get(p.name)),
  'banked drill experience should eventually improve permanent player traits');
assert.ok(developedWrs.every((p) =>
  p.rating === ratingFromTraits(p.pos, p.traits, p.rating)),
'permanent practice gains should update the player overall');

// Practicing a call affects that exact call and is frozen into liveConfig.
let playPractice = createSeason({ seed: 'play-practice', userTeam: TEAMS[0].id });
for (let period = 0; period < 3; period++) {
  playPractice = addPracticePeriod(playPractice, 'OC',
    { type: 'play', callId: 'verts' }).season;
}
assert.equal(+practiceEffects(playPractice, 'OC').plays.verts.toFixed(3), 0.039,
  'three default-play periods should sum diminishing familiarity gains');
assert.equal(practiceEffects(playPractice, 'OC').playReps.verts, 3,
  'practice effects should retain the rep count for transparent in-game feedback');
assert.ok(practicedStrength(playPractice).off > playPractice.strength[playPractice.userTeam].off,
  'rehearsed offensive calls should provide a modest expected-value benefit in fast simulation');
const scheduledPracticeGame = playPractice.schedule.games.find((g) =>
  g.home === playPractice.userTeam || g.away === playPractice.userTeam);
if (scheduledPracticeGame.week !== playPractice.week) {
  playPractice.week = scheduledPracticeGame.week;
  // Reassign at the scheduled week because practice is keyed to the calendar.
  for (let period = 0; period < 3; period++) {
    playPractice = addPracticePeriod(playPractice, 'OC',
      { type: 'play', callId: 'verts' }).season;
  }
}
const practiceCfg = liveConfig(playPractice, scheduledPracticeGame);
assert.equal(+practiceCfg.practice.OC.plays.verts.toFixed(3), 0.039,
  'the live game configuration should freeze practiced-play familiarity');
const basePracticeSnap = resolveSnap(newGameState({ firstPossession: 'US' }), 'verts', 'nick1',
  mulberry32(hashSeed('practice-edge')), emptyTendencies(), {
    offRoster: practiceCfg.rosters.US.offense, defRoster: practiceCfg.rosters.CPU.defense,
  });
const reppedPracticeSnap = resolveSnap(newGameState({ firstPossession: 'US' }), 'verts', 'nick1',
  mulberry32(hashSeed('practice-edge')), emptyTendencies(), {
    practiceEdge: practiceCfg.practice.OC.plays.verts,
    practiceReps: practiceCfg.practice.OC.playReps.verts,
    offRoster: practiceCfg.rosters.US.offense, defRoster: practiceCfg.rosters.CPU.defense,
  });
assert.equal(+(reppedPracticeSnap.edge - basePracticeSnap.edge).toFixed(3), 0.039,
  'play familiarity should add its exact bounded edge during snap resolution');
assert.equal(reppedPracticeSnap.practiceEdge, 0.039,
  'the outcome should expose practice impact for in-game feedback');
assert.equal(reppedPracticeSnap.practiceReps, 3,
  'the outcome should explain how many practice periods created its edge');
const playedPractice = { ...playPractice, results: [{
  week: playPractice.week, home: playPractice.userTeam, away: TEAMS[1].id, final: true,
}] };
assert.equal(practiceLocked(playedPractice), true,
  'practice should lock after the current game has been completed');
assert.throws(() => addPracticePeriod(playedPractice, 'OC',
  { type: 'drill', drillId: 'qb-accuracy' }), /locked/i,
'a completed game must not permit retroactive practice');
const customPracticeCall = { ...OFF_BY_ID.verts, id: 'custom-practice-call', custom: true };
registerCustomPlays([customPracticeCall]);
let customPractice = createSeason({ seed: 'custom-practice', userTeam: TEAMS[0].id });
assert.throws(() => addPracticePeriod(customPractice, 'OC',
  { type: 'play', callId: customPracticeCall.id }), /not installed/i,
'a custom call from another season cannot be practiced by guessing its id');
customPractice.customPlays = [customPracticeCall];
customPractice = addPracticePeriod(customPractice, 'OC',
  { type: 'play', callId: customPracticeCall.id }).season;
assert.equal(practiceEffects(customPractice, 'OC').plays[customPracticeCall.id], 0.026,
  'complex custom calls should receive the larger first-period familiarity benefit');

let defensivePractice = createSeason({ seed: 'defensive-practice', userTeam: TEAMS[0].id });
const defensiveGame = defensivePractice.schedule.games.find((g) =>
  g.home === defensivePractice.userTeam || g.away === defensivePractice.userTeam);
defensivePractice.week = defensiveGame.week;
defensivePractice = addPracticePeriod(defensivePractice, 'DC',
  { type: 'play', callId: 'base3' }).season;
const defensiveCfg = liveConfig(defensivePractice, defensiveGame);
const defensivePracticeGame = {
  state: newGameState({ firstPossession: 'CPU' }),
  tendencies: { US: emptyTendencies(), CPU: emptyTendencies() },
  filmPoints: { OC: 0, DC: 0 }, pending: {}, autoSeat: 'OC',
  gameplan: { OC: { tempo: 'normal' }, DC: {} },
  rosters: defensiveCfg.rosters, practice: defensiveCfg.practice,
  seasonSeed: defensivePractice.seed, them: defensiveCfg.them,
};
const defensivePracticeSnap = runToNextDecision('defensive-practice-game',
  defensivePracticeGame, { callId: 'base3' }).plays[0].outcome;
assert.equal(defensivePracticeSnap.practiceEdge, -0.02,
  'a practiced defensive call should apply its familiarity in the defense-favoring direction');
assert.ok(practicedStrength(defensivePractice).def
  > defensivePractice.strength[defensivePractice.userTeam].def,
'rehearsed defensive calls should provide a modest expected-value benefit in fast simulation');
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
const progressedSeason = nextSeason(offseason);
const progressedUser = progressedSeason.rosters[progressedSeason.userTeam].offense[0];
const progressedCpu = progressedSeason.rosters[TEAMS.find((t) => t.id !== progressedSeason.userTeam).id]
  .offense[0];
assert.ok(progressedUser.trainingXp && Object.keys(progressedUser.trainingXp).length,
  'the user roster should retain detailed trait experience across seasons');
assert.equal(progressedCpu.trainingXp, undefined,
  'CPU rosters should not bloat shared saves with unused explainability data');
assert.ok(Buffer.byteLength(JSON.stringify(dehydrate(progressedSeason))) < 900_000,
  'detailed user development should remain safely below Firestore document limits');

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
assert.equal(unlockedFilm.filmOverlays.DC.includes('mesh'), true);
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
assert.equal(designerUnlock.filmOverlays.DC.includes(unseenCall.id), true,
  'the upcoming opponent\'s default calls should unlock directly from the designer');

designerFilm.filmBank.OC = FILM_OVERLAY_COST;
const unseenDefense = DEFENSE.find((p) => !p.custom);
const offenseUnlock = unlockFilmOverlay(designerFilm, 'OC', designerOpponent, unseenDefense.id);
assert.equal(offenseUnlock.filmOverlays.OC.includes(unseenDefense.id), true,
  'the OC should unlock an opponent defense directly from the offensive designer');
assert.equal(offenseUnlock.filmBank.OC, 0,
  'an offensive overlay should spend the same film cost');

const migratedOverlay = hydrate({
  ...dehydrate(designerFilm),
  filmOverlays: { OC: [`${designerOpponent}:${unseenDefense.id}`], DC: [
    `${designerOpponent}:${unseenCall.id}`,
  ] },
});
assert.deepEqual(migratedOverlay.filmOverlays.OC, [unseenDefense.id],
  'legacy opponent-scoped offensive overlays should migrate to permanent concept ownership');
assert.deepEqual(migratedOverlay.filmOverlays.DC, [unseenCall.id],
  'legacy opponent-scoped defensive overlays should migrate to permanent concept ownership');
const otherGame = migratedOverlay.schedule.games.find((game) =>
  (game.home === filmUs || game.away === filmUs)
  && game.home !== designerOpponent && game.away !== designerOpponent);
const otherOpponent = otherGame.home === filmUs ? otherGame.away : otherGame.home;
const revisitedOverlay = { ...migratedOverlay, week: otherGame.week };
const alreadyOwned = unlockFilmOverlay(revisitedOverlay, 'DC', otherOpponent, unseenCall.id);
assert.equal(alreadyOwned, revisitedOverlay,
  'a concept bought against one opponent should not charge film again against another');

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

let explicitMan = setManAssignment({}, 'CB2', 'WR1');
explicitMan = setManAssignment(explicitMan, 'NB', 'WR1');
assert.deepEqual(explicitMan, { NB: 'WR1' },
  'reassigning a receiver should replace his old primary defender');
explicitMan = setManAssignment(explicitMan, 'NB', 'TE1');
assert.deepEqual(explicitMan, { NB: 'TE1' },
  'reassigning a defender should replace his old receiver');

const drawnMatch = deriveDefense({
  id: 'drawn-match', name: 'Drawn Match', positions: {}, man: false,
  offensePers: '11', manAssignments: { CB2: 'WR1' },
  paths: {
    EDGE1: [[17, 1], [17, -3]], DT1: [[23, 1], [23, -3]],
    DT2: [[30, 1], [30, -3]], EDGE2: [[36, 1], [36, -3]],
    S1: [[20, 13], [16, 20]], S2: [[34, 13], [38, 20]],
  },
});
assert.deepEqual(drawnMatch.geometry.manAssignments, { CB2: 'WR1' },
  'a custom defense should preserve exact defender-to-receiver matchups');
assert.equal(drawnMatch.structure.manCount, 1,
  'the defense readout should count explicit man assignments');
const matchupDefense = statSeason.rosters[TEAMS[1].id].defense;
assert.equal(coverDefender('WR1', drawnMatch, matchupDefense)?.spot, 'CB2',
  'the live talent resolver should use the defender selected in the designer');
assert.ok(Number.isFinite(spatialMatchup(OFF_BY_ID.mesh, drawnMatch).reads.WR1),
  'route geometry should evaluate an explicit man matchup alongside remaining zones');
registerCustomDefenses([drawnMatch]);
const assignmentTargetPlay = {
  ...OFF_BY_ID.slants, id: 'assignment-target', name: 'Assignment Target',
  custom: true, targets: { WR1: 100 },
};
registerCustomPlays([assignmentTargetPlay]);
const assignedSnap = resolveSnap(newGameState({ firstPossession: 'US' }), assignmentTargetPlay.id, drawnMatch.id,
  () => 0.99, emptyTendencies(), {
    offRoster: statSeason.rosters[statSeason.userTeam].offense,
    defRoster: matchupDefense,
  });
assert.equal(assignedSnap.playerMatchup.defense.player,
  matchupDefense.find((player) => player.spot === 'CB2').name,
  'the snap resolver should grade the receiver against his explicitly assigned defender');

const drawnManShell = deriveDefense({
  id: 'drawn-man-shell', name: 'Drawn Man Shell', positions: {}, man: false,
  manAssignments: { CB1: 'WR1', CB2: 'WR2', NB: 'WR3' }, paths: {},
});
assert.equal(drawnManShell.cov, 'man1',
  'three explicit receiver matchups should compile into a man coverage shell');

console.log('Regression tests passed.');
