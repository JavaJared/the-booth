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

export const QUESTIONS = [
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
  { id: 'identity', q: 'What is this team going to look like when it is right?',
    options: [
      { t: 'Physical. We run it, we stop the run, we win the fourth quarter.',
        s: { identity: 1.0, authority: 0.5, accountability: 0.3 } },
      { t: 'Fast and aggressive. We push tempo and we take shots.',
        s: { aggression: 1.0, identity: 0.6 } },
      { t: 'Whatever this roster is best at. I would rather win ugly than lose on principle.',
        s: { adaptability: 1.0, collaboration: 0.4, development: 0.3 } },
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
];

/** Five questions per interview, stable for a given opening. */
export function interviewQuestions(seed, teamId) {
  const rng = mulberry32(hashSeed(`${seed}:iv:${teamId}`));
  const pool = [...QUESTIONS];
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, 5);
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
