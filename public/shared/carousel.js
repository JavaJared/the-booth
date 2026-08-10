// carousel.js — the way out of the booth.
// CPU clubs judge their coaches, fire the ones falling short, then decide who
// to interview. What an owner wants depends on the club: the answer that wins
// a rebuilding job loses a win-now job, so the work is reading the opening
// before you read the questions.
import { TEAMS, TEAM_BY_ID, fullName, sortedStandings } from './league.js';
import { seasonUnitStats, unitRanks } from './fastsim.js';
import { mulberry32, hashSeed } from './engine.js';
import { FIRST, LAST } from './names.js';

/* ---------------------------------------------------------------- coaches */

export function makeCoaches(seed) {
  const rng = mulberry32(hashSeed(`${seed}:coaches`));
  const used = new Set();
  const out = {};
  for (const t of TEAMS) {
    let name;
    do { name = `${FIRST[Math.floor(rng() * FIRST.length)]} ${LAST[Math.floor(rng() * LAST.length)]}`; }
    while (used.has(name));
    used.add(name);
    out[t.id] = {
      name,
      tenure: 1 + Math.floor(rng() * 6),
      // How long an owner will wait before losing patience. Low means itchy.
      patience: 0.55 + rng() * 0.9,
      background: rng() < 0.5 ? 'offense' : 'defense',
    };
  }
  return out;
}

/**
 * How hot a coach's seat is, roughly in wins-below-expectation.
 * Expectation comes from roster strength, so inheriting a bad team buys time
 * and inheriting a good one does not.
 */
export function heatFor(teamId, { standings, strength, coaches, playoffs }) {
  const row = standings.byId[teamId];
  const coach = coaches[teamId];
  if (!row || !coach) return 0;

  const s = strength[teamId];
  const quality = (s.off - 75) + (s.def - 74);           // roughly -12 .. +12
  const expected = 8.5 + quality * 0.42;
  const shortfall = expected - row.w;

  let heat = shortfall / coach.patience;
  heat += Math.max(0, coach.tenure - 3) * 0.35;           // the honeymoon ends
  if (row.w >= 12) heat -= 3.5;
  if (playoffs?.includes(teamId)) heat -= 2.2;
  if (row.w <= 4) heat += 1.6;
  return +heat.toFixed(2);
}

/** Black Monday. Returns the clubs with a vacancy. */
export function firings(season, coaches) {
  const reg = season.results.filter((r) => !r.playoff);
  const standings = sortedStandings(reg);
  const inPlayoffs = season.playoffs
    ? [...season.playoffs.seeds.N, ...season.playoffs.seeds.S].map((s) => s.id)
    : [];
  const rng = mulberry32(hashSeed(`${season.seed}:fire:${season.year}`));

  const rows = TEAMS.map((t) => ({
    id: t.id,
    heat: heatFor(t.id, { standings, strength: season.strength, coaches, playoffs: inPlayoffs }),
  })).sort((a, b) => b.heat - a.heat);

  const out = [];
  for (const r of rows) {
    // A threshold plus noise: owners are not a formula, and a fixed cutoff
    // makes every offseason identical.
    if (r.heat > 2.75 + rng() * 1.8) out.push(r.id);
  }
  // Keep the market in a believable range rather than firing half the league.
  return out.slice(0, 9);
}

/* ---------------------------------------------------------------- openings */

const ARCHETYPES = {
  rebuild: {
    label: 'Rebuild',
    blurb: 'Young roster, no expectations yet. They want someone who can develop people.',
    wants: { patience: 1.0, development: 0.9, collaboration: 0.6, adaptability: 0.5,
             accountability: 0.4, authority: 0.1, aggression: 0.2, identity: 0.3 },
  },
  winNow: {
    label: 'Win now',
    blurb: 'Talent in place and a closing window. They want someone who will push.',
    wants: { aggression: 1.0, identity: 0.8, authority: 0.7, accountability: 0.5,
             adaptability: 0.4, collaboration: 0.3, development: 0.1, patience: 0.0 },
  },
  reset: {
    label: 'Culture reset',
    blurb: 'The building has gone soft. They want standards enforced from day one.',
    wants: { authority: 1.0, accountability: 0.9, identity: 0.6, collaboration: 0.4,
             aggression: 0.3, patience: 0.3, development: 0.3, adaptability: 0.2 },
  },
  offenseFirst: {
    label: 'Needs offense',
    blurb: 'They cannot score. They want a coach who will fix that first.',
    wants: { identity: 0.9, aggression: 0.8, adaptability: 0.7, development: 0.6,
             collaboration: 0.4, accountability: 0.3, patience: 0.2, authority: 0.2 },
  },
  defenseFirst: {
    label: 'Needs defense',
    blurb: 'They cannot get a stop. They want structure and toughness.',
    wants: { identity: 0.9, accountability: 0.7, authority: 0.6, adaptability: 0.6,
             aggression: 0.4, collaboration: 0.4, development: 0.3, patience: 0.2 },
  },
};

export const archetypeOf = (key) => ARCHETYPES[key];

/** Read the club's season and decide what kind of coach it is looking for. */
export function openingFor(teamId, season, coaches) {
  const reg = season.results.filter((r) => !r.playoff);
  const stats = seasonUnitStats(reg, TEAMS.map((t) => t.id));
  const ranks = unitRanks(stats);
  const row = sortedStandings(reg).byId[teamId];
  const s = season.strength[teamId];

  const offRank = ranks.offense.points[teamId];
  const defRank = ranks.defense.points[teamId];
  const talent = (s.off - 75) + (s.def - 74);

  let key;
  if (talent > 3.5 && row.w >= 7) key = 'winNow';
  else if (talent < -3) key = 'rebuild';
  else if (offRank >= 24 && offRank > defRank + 6) key = 'offenseFirst';
  else if (defRank >= 24 && defRank > offRank + 6) key = 'defenseFirst';
  else if (row.w <= 5) key = 'reset';
  else key = talent >= 0 ? 'winNow' : 'rebuild';

  return {
    teamId,
    archetype: key,
    ...ARCHETYPES[key],
    record: { w: row.w, l: row.l, t: row.t },
    offRank, defRank,
    firedCoach: coaches[teamId]?.name,
    // What the club values in a résumé, separate from the interview.
    prefersUnit: key === 'offenseFirst' ? 'offense' : key === 'defenseFirst' ? 'defense' : null,
  };
}

/* ---------------------------------------------------------------- résumés */

/**
 * Score a coordinator's season the way a hiring club would read it.
 * 0–100, and deliberately weighted toward unit rank over team record: you do
 * not control the other side of the ball.
 */
export function resumeScore(res, opening) {
  const rankPoints = (r) => Math.max(0, (33 - r) / 32) * 100;
  const unit = 0.45 * rankPoints(res.ranks.points) + 0.35 * rankPoints(res.ranks.ypp)
             + 0.20 * rankPoints(res.ranks.third);
  const played = res.gamesPlayed || 1;
  const winPct = (res.record.w + res.record.t * 0.5) / played;

  let score = 0.62 * unit + 0.24 * (winPct * 100);
  // Calling your own games is the difference between a coordinator with a
  // record and one whose staff has a record.
  score += 14 * Math.min(1, (res.gamesCalled || 0) / played);
  if (opening?.prefersUnit && opening.prefersUnit === res.unit) score += 8;
  if (opening?.archetype === 'winNow' && res.record.w >= 11) score += 5;
  if (opening?.archetype === 'rebuild' && res.ranks.ypp <= 12) score += 4;
  return Math.max(0, Math.min(100, +score.toFixed(1)));
}

/* ---------------------------------------------------------------- interview */

/* Three banks. Every candidate answers leadership questions; the football
   questions depend on which side of the ball you actually coach. Pools are
   deliberately larger than an interview needs, so two clubs ask you different
   things and you cannot memorise one answer key. */

export const SHARED_QUESTIONS = [
  { id: 'staff', q: 'How do you build your staff?',
    options: [
      { t: 'Experienced coordinators I can argue with. I want people who will tell me I am wrong.',
        s: { collaboration: 1.0, accountability: 0.6, adaptability: 0.4 } },
      { t: 'People I have worked with. Trust moves faster than talent in a first year.',
        s: { authority: 0.8, identity: 0.5, patience: 0.3 } },
      { t: 'Teachers. Young rosters get better through position coaches, not coordinators.',
        s: { development: 1.0, patience: 0.6, collaboration: 0.4 } },
    ] },
  { id: 'losing', q: 'You lose three in a row in October. What do the players hear from you?',
    options: [
      { t: 'That it starts with me, and here is specifically what I got wrong.',
        s: { accountability: 1.0, collaboration: 0.5 } },
      { t: 'That we are not changing who we are because of three weeks.',
        s: { identity: 1.0, authority: 0.5, patience: 0.4 } },
      { t: 'That what is not working is getting cut this week. All of it.',
        s: { adaptability: 1.0, aggression: 0.5, authority: 0.4 } },
    ] },
  { id: 'gm', q: 'How much say should the general manager have over the roster?',
    options: [
      { t: 'It is his roster. My job is to coach the players he gets me and be honest about what I need.',
        s: { collaboration: 1.0, accountability: 0.5 } },
      { t: 'Final say on the fifty-three. I cannot be held to a standard I do not control.',
        s: { authority: 1.0, accountability: 0.4 } },
      { t: 'We agree on the profile of player before the draft, then he picks. Disagreements happen in March, not September.',
        s: { collaboration: 0.7, identity: 0.6, adaptability: 0.4 } },
    ] },
  { id: 'star', q: 'Your best player skips a voluntary workout and the beat writers notice.',
    options: [
      { t: 'It is voluntary. I call him, I ask how he is, and we move on.',
        s: { collaboration: 0.9, patience: 0.6 } },
      { t: 'The standard is the standard. If it does not apply to him it does not apply to anyone.',
        s: { authority: 1.0, accountability: 0.7 } },
      { t: 'I find out why. Usually there is a reason, and usually it is worth knowing.',
        s: { development: 0.7, collaboration: 0.6, adaptability: 0.4 } },
    ] },
  { id: 'year1', q: 'What does a successful first season look like here?',
    options: [
      { t: 'We are in the playoff race in December. Anything less is a wasted year.',
        s: { aggression: 0.9, authority: 0.5, identity: 0.4 } },
      { t: 'The young players are visibly better in week eighteen than week one.',
        s: { development: 1.0, patience: 0.9 } },
      { t: 'Nobody can watch us and not know exactly what we are trying to do.',
        s: { identity: 1.0, accountability: 0.4 } },
    ] },
  { id: 'address', q: 'First team meeting. What is the message?',
    options: [
      { t: 'Here are the rules, here are the consequences, and they start now.',
        s: { authority: 1.0, accountability: 0.6 } },
      { t: 'Here is what we are going to be great at, and how each of you fits into it.',
        s: { identity: 0.9, development: 0.5, collaboration: 0.4 } },
      { t: 'I mostly listen. I want to know what has been wrong in here before I start talking.',
        s: { collaboration: 1.0, adaptability: 0.6, patience: 0.5 } },
    ] },
  { id: 'analytics', q: 'What does your analytics department do for you?',
    options: [
      { t: 'They set my fourth-down card and I follow it. That is what it is for.',
        s: { aggression: 1.0, adaptability: 0.5 } },
      { t: 'They inform. The call still comes from what I am seeing on the field.',
        s: { authority: 0.7, identity: 0.6, adaptability: 0.3 } },
      { t: 'Mostly self-scouting. I want to know what we are tipping before an opponent does.',
        s: { accountability: 0.8, adaptability: 0.8, collaboration: 0.4 } },
    ] },
  { id: 'media', q: 'A reporter asks why you benched a popular veteran.',
    options: [
      { t: 'I say it was my decision and I do not discuss individual players publicly.',
        s: { authority: 0.9, accountability: 0.5 } },
      { t: 'I explain the standard he did not meet. The room already knows anyway.',
        s: { accountability: 1.0, identity: 0.4 } },
      { t: 'I say he is working through something and I expect him back. Then I go tell him that first.',
        s: { collaboration: 0.9, development: 0.5, patience: 0.4 } },
    ] },
  { id: 'practice', q: 'How do you run a Wednesday in November?',
    options: [
      { t: 'Padded and physical. You cannot play a way you never practise.',
        s: { identity: 0.9, authority: 0.6 } },
      { t: 'Legs first. I would rather be fresh in December than right in October.',
        s: { patience: 0.9, adaptability: 0.5, collaboration: 0.3 } },
      { t: 'Depends on the week and the age of the roster. I ask the strength staff.',
        s: { collaboration: 0.8, adaptability: 0.8, development: 0.4 } },
    ] },
  { id: 'captains', q: 'How do you pick captains?',
    options: [
      { t: 'The players vote. It means nothing if it comes from me.',
        s: { collaboration: 1.0, accountability: 0.4 } },
      { t: 'I appoint them. Leadership is a job, not a popularity contest.',
        s: { authority: 1.0, identity: 0.4 } },
      { t: 'I do not name any until midseason. Let me see who they actually follow.',
        s: { patience: 0.8, adaptability: 0.7, development: 0.4 } },
    ] },
];

export const OFFENSE_QUESTIONS = [
  { id: 'fourth', q: 'Fourth and two at midfield, down four, eight minutes left. What is the call?',
    options: [
      { t: 'We go. The numbers say go and I want the room to know we play to win.',
        s: { aggression: 1.0, authority: 0.4, identity: 0.3 } },
      { t: 'Punt, pin them deep, trust the defense to get it back.',
        s: { patience: 0.7, collaboration: 0.4, identity: 0.3 } },
      { t: 'Depends who is healthy. If we can get two yards on the ground, we go.',
        s: { adaptability: 1.0, accountability: 0.3, aggression: 0.4 } },
    ] },
  { id: 'qb', q: 'Our quarterback is twenty-three and had a rough year. What is your first move with him?',
    options: [
      { t: 'Build the whole offense around what he already does well and let him grow into the rest.',
        s: { development: 1.0, patience: 0.8, adaptability: 0.5 } },
      { t: 'Open the job. Competition tells you more about a young player than coaching does.',
        s: { authority: 0.9, accountability: 0.4, aggression: 0.4 } },
      { t: 'Fix the environment first — protection, run game, play-action. Quarterbacks look bad in bad structures.',
        s: { identity: 0.8, development: 0.6, collaboration: 0.4 } },
    ] },
  { id: 'offid', q: 'What does this offense look like when it is right?',
    options: [
      { t: 'Physical. We run it, we control the clock, we win the fourth quarter.',
        s: { identity: 1.0, authority: 0.5, accountability: 0.3 } },
      { t: 'Fast. We push tempo, we spread you out, we take our shots.',
        s: { aggression: 1.0, identity: 0.6 } },
      { t: 'Whatever this roster is best at. I would rather win ugly than lose on principle.',
        s: { adaptability: 1.0, collaboration: 0.4, development: 0.3 } },
    ] },
  { id: 'redzone', q: 'You are settling for field goals. What changes?',
    options: [
      { t: 'We get heavier and run it in. Down there it is a will problem.',
        s: { identity: 0.9, authority: 0.6 } },
      { t: 'We throw it on early downs. The field is short, so take the shot before they load up.',
        s: { aggression: 1.0, adaptability: 0.4 } },
      { t: 'We look at who is actually getting open down there and build around him.',
        s: { adaptability: 0.8, development: 0.6, collaboration: 0.5 } },
    ] },
  { id: 'oline', q: 'Your line is the weakest unit on the roster. How do you coach around it?',
    options: [
      { t: 'Quick game and movement. Get the ball out before it matters.',
        s: { adaptability: 1.0, aggression: 0.3 } },
      { t: 'Keep tight ends and backs in. I am not asking a young quarterback to survive.',
        s: { patience: 0.8, development: 0.6, collaboration: 0.3 } },
      { t: 'We run at them anyway. You do not fix a line by hiding it.',
        s: { identity: 1.0, authority: 0.6, accountability: 0.4 } },
    ] },
  { id: 'skill', q: 'You have one genuinely elite skill player. How do you use him?',
    options: [
      { t: 'Move him everywhere. Make them declare how they are handling him.',
        s: { adaptability: 0.9, aggression: 0.6 } },
      { t: 'Feed him. Twenty-five touches and let the rest sort itself out.',
        s: { aggression: 0.8, identity: 0.6, authority: 0.4 } },
      { t: 'Use him to create space for everyone else. The attention is worth more than the targets.',
        s: { collaboration: 0.8, development: 0.6, identity: 0.4 } },
    ] },
  { id: 'tempo', q: 'Two-minute before halftime, ball on your own twenty, one timeout.',
    options: [
      { t: 'We go. Points before the half swing games.',
        s: { aggression: 1.0, authority: 0.4 } },
      { t: 'We run it out. Nothing good happens backed up with one timeout.',
        s: { patience: 0.9, identity: 0.4 } },
      { t: 'Two first downs and then we decide. Let the situation tell us.',
        s: { adaptability: 1.0, collaboration: 0.4 } },
    ] },
];

export const DEFENSE_QUESTIONS = [
  { id: 'pressure', q: 'How do you get to the quarterback?',
    options: [
      { t: 'We bring people. Pressure changes what a quarterback sees before the snap.',
        s: { aggression: 1.0, authority: 0.4, identity: 0.4 } },
      { t: 'Four men. If I have to blitz to be good, my front is not good enough.',
        s: { identity: 1.0, patience: 0.4, development: 0.3 } },
      { t: 'Depends on the week. Some quarterbacks you rattle, some you make hold the ball.',
        s: { adaptability: 1.0, collaboration: 0.4 } },
    ] },
  { id: 'coverage', q: 'What is your base coverage philosophy?',
    options: [
      { t: 'Man. Ask your corners to cover and find out fast who can.',
        s: { aggression: 0.9, authority: 0.6, accountability: 0.4 } },
      { t: 'Zone with a plan. Keep it in front, tackle well, make them earn twelve plays.',
        s: { patience: 0.9, identity: 0.6 } },
      { t: 'Whatever this secondary can execute cleanly. A simple call run right beats a good call run wrong.',
        s: { adaptability: 1.0, development: 0.6, collaboration: 0.4 } },
    ] },
  { id: 'runfit', q: 'You are getting gashed on the ground. Monday morning, what is the fix?',
    options: [
      { t: 'More bodies in the box and we live with it on the back end.',
        s: { aggression: 0.8, authority: 0.6, identity: 0.4 } },
      { t: 'It is fits and tackling, not numbers. We fix it in practice, not on the call sheet.',
        s: { accountability: 1.0, development: 0.6, patience: 0.4 } },
      { t: 'We change personnel. If a linebacker cannot take on a guard he cannot play for me.',
        s: { authority: 0.9, accountability: 0.5, aggression: 0.4 } },
    ] },
  { id: 'takeaway', q: 'Takeaways or points allowed — which number do you live by?',
    options: [
      { t: 'Takeaways. I will trade a few big plays for the chances they create.',
        s: { aggression: 1.0, identity: 0.5 } },
      { t: 'Points. Bend, do not break, and make them drive it eighty every time.',
        s: { patience: 1.0, accountability: 0.5 } },
      { t: 'Whichever one the offense needs that week. We serve the team, not a stat.',
        s: { collaboration: 1.0, adaptability: 0.7 } },
    ] },
  { id: 'thirddown', q: 'Third and seven. What is your default?',
    options: [
      { t: 'Simulated pressure. Show them heat, drop out, take the throw away.',
        s: { adaptability: 1.0, aggression: 0.5 } },
      { t: 'Send an extra man and make him beat it hot.',
        s: { aggression: 1.0, authority: 0.4 } },
      { t: 'Rush four, play the sticks, tackle at six.',
        s: { identity: 0.9, patience: 0.6 } },
    ] },
  { id: 'youngdb', q: 'You have a rookie corner getting picked on every week.',
    options: [
      { t: 'He plays. He learns in games or he never learns.',
        s: { development: 0.8, authority: 0.7, accountability: 0.4 } },
      { t: 'Help him with a safety until he earns the trust to be alone.',
        s: { patience: 0.9, development: 0.7, collaboration: 0.4 } },
      { t: 'He sits until he is ready. I am not sacrificing games to teach one player.',
        s: { authority: 0.9, aggression: 0.4, identity: 0.4 } },
    ] },
  { id: 'goalline', q: 'They have first and goal from the four.',
    options: [
      { t: 'Load the box, dare them to throw it, win with bodies.',
        s: { identity: 0.9, authority: 0.5 } },
      { t: 'Play the pass. Down there the throw beats you, not the run.',
        s: { adaptability: 0.9, patience: 0.5 } },
      { t: 'Bring pressure. Make the read hard in a small space.',
        s: { aggression: 1.0, identity: 0.4 } },
    ] },
];

/** Every question, for tooling that wants the whole bank. */
export const QUESTIONS = [...SHARED_QUESTIONS, ...OFFENSE_QUESTIONS, ...DEFENSE_QUESTIONS];

const pick = (pool, n, rng) => {
  const a = [...pool];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a.slice(0, n);
};

/**
 * Six questions: three about leading a building, three about the side of the
 * ball you actually coach. Stable for a given club and seat, different between
 * clubs, and different for the two coordinators interviewing at the same club.
 */
export function interviewQuestions(seed, teamId, seat = 'OC') {
  const rng = mulberry32(hashSeed(`${seed}:iv:${teamId}:${seat}`));
  const football = seat === 'DC' ? DEFENSE_QUESTIONS : OFFENSE_QUESTIONS;
  const out = [...pick(SHARED_QUESTIONS, 3, rng), ...pick(football, 3, rng)];
  return pick(out, out.length, rng);   // interleave the two kinds
}

/** 0–100 against what this particular owner is listening for. */
export function interviewScore(answers, opening) {
  const wants = ARCHETYPES[opening.archetype].wants;
  let got = 0, best = 0, worst = 0;
  for (const { question, choice } of answers) {
    const scoreOf = (opt) => Object.entries(opt.s)
      .reduce((a, [k, v]) => a + v * (wants[k] || 0), 0);
    const all = question.options.map(scoreOf);
    got += scoreOf(question.options[choice]);
    best += Math.max(...all);
    worst += Math.min(...all);
  }
  if (best === worst) return 50;
  return +(((got - worst) / (best - worst)) * 100).toFixed(1);
}

/* ---------------------------------------------------------------- hiring */

/** Rival candidates so a club is never choosing between you and nobody. */
export function rivalPool(seed, opening, n = 4) {
  const rng = mulberry32(hashSeed(`${seed}:pool:${opening.teamId}`));
  const out = [];
  const used = new Set();
  for (let i = 0; i < n; i++) {
    let name;
    do { name = `${FIRST[Math.floor(rng() * FIRST.length)]} ${LAST[Math.floor(rng() * LAST.length)]}`; }
    while (used.has(name));
    used.add(name);
    const resume = 38 + rng() * 46;
    const interview = 34 + rng() * 52;
    out.push({
      name,
      unit: rng() < 0.5 ? 'offense' : 'defense',
      role: rng() < 0.25 ? 'Head coach, college' : rng() < 0.6 ? 'Offensive coordinator' : 'Defensive coordinator',
      resume: +resume.toFixed(1),
      interview: +interview.toFixed(1),
      total: +(0.55 * resume + 0.45 * interview).toFixed(1),
    });
  }
  return out.sort((a, b) => b.total - a.total);
}

/** Does a club want to talk to this coordinator at all? */
export function invitesFor(opening, candidates, seed) {
  const rng = mulberry32(hashSeed(`${seed}:invite:${opening.teamId}`));
  return candidates.filter((c) => {
    const score = resumeScore(c.resume, opening);
    // Strong résumés are close to automatic; weak ones need luck.
    const bar = 46 + rng() * 22;
    return score >= bar;
  });
}

export function hire(opening, me, rivals) {
  const total = +(0.55 * me.resume + 0.45 * me.interview).toFixed(1);
  const field = [...rivals, { ...me, name: me.name || 'You', you: true, total }]
    .sort((a, b) => b.total - a.total);
  return { field, hired: field[0], got: !!field[0].you, total };
}
