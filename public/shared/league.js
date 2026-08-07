// league.js — the world outside your booth: 32 teams, a schedule, standings,
// and a bracket. Pure functions over plain data so the server can own it and
// the client can render it without a second implementation.
import { mulberry32, hashSeed } from './engine.js';

/* ---------------------------------------------------------------- teams
   Cities without a real pro football team, so nothing reads as a knockoff. */
export const TEAMS = [
  // NORTHERN conference
  { id: 'HAR', city: 'Hartford',        name: 'Anvils',        conf: 'N', div: 'NE' },
  { id: 'PRO', city: 'Providence',      name: 'Longshoremen',  conf: 'N', div: 'NE' },
  { id: 'RIC', city: 'Richmond',        name: 'Ironworks',     conf: 'N', div: 'NE' },
  { id: 'NOR', city: 'Norfolk',         name: 'Dredgers',      conf: 'N', div: 'NE' },

  { id: 'TOL', city: 'Toledo',          name: 'Foundry',       conf: 'N', div: 'NC' },
  { id: 'OMA', city: 'Omaha',           name: 'Sodbusters',    conf: 'N', div: 'NC' },
  { id: 'DSM', city: 'Des Moines',      name: 'Threshers',     conf: 'N', div: 'NC' },
  { id: 'WIC', city: 'Wichita',         name: 'Cyclone',       conf: 'N', div: 'NC' },

  { id: 'BIR', city: 'Birmingham',      name: 'Blastworks',    conf: 'N', div: 'NS' },
  { id: 'KNX', city: 'Knoxville',       name: 'Highlanders',   conf: 'N', div: 'NS' },
  { id: 'MOB', city: 'Mobile',          name: 'Rivermen',      conf: 'N', div: 'NS' },
  { id: 'SAV', city: 'Savannah',        name: 'Kestrels',      conf: 'N', div: 'NS' },

  { id: 'SPO', city: 'Spokane',         name: 'Cascade',       conf: 'N', div: 'NW' },
  { id: 'BOI', city: 'Boise',           name: 'Bighorns',      conf: 'N', div: 'NW' },
  { id: 'ANC', city: 'Anchorage',       name: 'Frostbacks',    conf: 'N', div: 'NW' },
  { id: 'RNO', city: 'Reno',            name: 'Prospectors',   conf: 'N', div: 'NW' },

  // SOUTHERN conference
  { id: 'CHS', city: 'Charleston',      name: 'Privateers',    conf: 'S', div: 'SE' },
  { id: 'LOU', city: 'Louisville',      name: 'Coopers',       conf: 'S', div: 'SE' },
  { id: 'LIT', city: 'Little Rock',     name: 'Copperheads',   conf: 'S', div: 'SE' },
  { id: 'SHV', city: 'Shreveport',      name: 'Bayou Kings',   conf: 'S', div: 'SE' },

  { id: 'TUL', city: 'Tulsa',           name: 'Derrickmen',    conf: 'S', div: 'SC' },
  { id: 'OKC', city: 'Oklahoma City',   name: 'Stampede',      conf: 'S', div: 'SC' },
  { id: 'SAT', city: 'San Antonio',     name: 'Wranglers',     conf: 'S', div: 'SC' },
  { id: 'ELP', city: 'El Paso',         name: 'Rattlers',      conf: 'S', div: 'SC' },

  { id: 'ABQ', city: 'Albuquerque',     name: 'Roadrunners',   conf: 'S', div: 'SM' },
  { id: 'COS', city: 'Colorado Springs',name: 'Summiteers',    conf: 'S', div: 'SM' },
  { id: 'SLC', city: 'Salt Lake',       name: 'Quarrymen',     conf: 'S', div: 'SM' },
  { id: 'TUC', city: 'Tucson',          name: 'Sidewinders',   conf: 'S', div: 'SM' },

  { id: 'POR', city: 'Portland',        name: 'Lumberjacks',   conf: 'S', div: 'SW' },
  { id: 'SAC', city: 'Sacramento',      name: 'Goldfields',    conf: 'S', div: 'SW' },
  { id: 'FRE', city: 'Fresno',          name: 'Vaqueros',      conf: 'S', div: 'SW' },
  { id: 'HON', city: 'Honolulu',        name: 'Voyagers',      conf: 'S', div: 'SW' },
];

export const TEAM_BY_ID = Object.fromEntries(TEAMS.map((t) => [t.id, t]));
const BYE_WINDOW = (w) => w >= 5 && w <= 14;
export const DIVISIONS = [...new Set(TEAMS.map((t) => t.div))];
export const divisionOf = (id) => TEAM_BY_ID[id].div;
export const confOf = (id) => TEAM_BY_ID[id].conf;
export const fullName = (id) => `${TEAM_BY_ID[id].city} ${TEAM_BY_ID[id].name}`;

const WEEKS = 18;
const BYE_WEEKS = [5, 6, 7, 8, 9, 10, 11, 12, 13, 14];

/* ---------------------------------------------------------------- matchups
   The real formula, simplified: home-and-home inside your division, one full
   division from each conference, and two more against same-place finishers. */
function buildMatchups(rng) {
  const games = [];
  const add = (home, away) => games.push({ home, away });
  const byDiv = {};
  for (const t of TEAMS) (byDiv[t.div] = byDiv[t.div] || []).push(t.id);

  // 6: home and away against each division rival
  for (const div of DIVISIONS) {
    const d = byDiv[div];
    for (let i = 0; i < d.length; i++) {
      for (let j = i + 1; j < d.length; j++) { add(d[i], d[j]); add(d[j], d[i]); }
    }
  }

  const nDivs = DIVISIONS.filter((d) => d[0] === 'N');
  const sDivs = DIVISIONS.filter((d) => d[0] === 'S');

  // 4: one division from your own conference (rotating pairing)
  const pairWithin = (divs) => {
    const shuffled = shuffle(divs, rng);
    return [[shuffled[0], shuffled[1]], [shuffled[2], shuffled[3]]];
  };
  for (const [a, b] of [...pairWithin(nDivs), ...pairWithin(sDivs)]) {
    byDiv[a].forEach((h, i) => byDiv[b].forEach((v, j) => {
      // alternate the host so home games stay balanced
      if ((i + j) % 2 === 0) add(h, v); else add(v, h);
    }));
  }

  // 4: one division from the other conference
  const cross = shuffle(sDivs, rng);
  shuffle(nDivs, rng).forEach((n, k) => {
    const s = cross[k];
    byDiv[n].forEach((h, i) => byDiv[s].forEach((v, j) => {
      if ((i + j) % 2 === 0) add(h, v); else add(v, h);
    }));
  });

  // 3 more inside the conference to reach 17, avoiding repeats
  const count = {}, homeCount = {};
  for (const t of TEAMS) { count[t.id] = 0; homeCount[t.id] = 0; }
  for (const g of games) { count[g.home]++; count[g.away]++; homeCount[g.home]++; }
  const seen = new Set(games.map((g) => key(g.home, g.away)));

  for (const conf of ['N', 'S']) {
    const pool = shuffle(TEAMS.filter((t) => t.conf === conf).map((t) => t.id), rng);
    let guard = 0;
    while (guard++ < 6000) {
      const short = pool.filter((t) => count[t] < 17);
      if (!short.length) break;
      let placed = false;
      for (const a of short) {
        for (const b of shuffle(short.filter((x) => x !== a), rng)) {
          if (divisionOf(a) === divisionOf(b)) continue;
          if (seen.has(key(a, b))) continue;
          // Give the home game to whoever has fewer, so nobody ends 10-7.
          const home = homeCount[a] === homeCount[b]
            ? (rng() < 0.5 ? a : b)
            : (homeCount[a] < homeCount[b] ? a : b);
          add(home, home === a ? b : a);
          homeCount[home]++;
          seen.add(key(a, b));
          count[a]++; count[b]++;
          placed = true;
          break;
        }
        if (placed) break;
      }
      if (!placed) {
        // Wedged: the last few teams can only face opponents they already have.
        // Drop a recent filler game and let the loop try a different pairing.
        const removable = games.slice(-8).filter((g) => confOf(g.home) === conf);
        if (!removable.length) return null;
        const drop = removable[Math.floor(rng() * removable.length)];
        games.splice(games.indexOf(drop), 1);
        seen.delete(key(drop.home, drop.away));
        count[drop.home]--; count[drop.away]--;
      }
    }
  }
  // Final sweep: flip a game's host wherever it fixes a 10-7 split.
  for (let pass = 0; pass < 4; pass++) {
    for (const g of games) {
      if (homeCount[g.home] > 9 && homeCount[g.away] < 9) {
        homeCount[g.home]--; homeCount[g.away]++;
        [g.home, g.away] = [g.away, g.home];
      }
    }
  }
  return games;
}

const key = (a, b) => [a, b].sort().join('-');

function shuffle(arr, rng) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/* ---------------------------------------------------------------- weeks
   Every team plays 17 games across 18 weeks, so almost every week has to be a
   perfect matching of the whole league. Greedy assignment wedges immediately.
   This is edge colouring — the matchup graph is 17-regular, and Vizing
   guarantees 18 colours suffice — so a solution always exists. Min-conflicts
   local search finds one in a few thousand moves. */
function assignWeeks(games, rng) {
  const ids = TEAMS.map((t) => t.id);
  const grid = {};
  for (const id of ids) grid[id] = new Array(WEEKS + 1).fill(0);

  const weights = [];
  for (let w = 1; w <= WEEKS; w++) weights.push(BYE_WINDOW(w) ? 1 : 2.2);
  const totalW = weights.reduce((a, b) => a + b, 0);
  const drawWeek = () => {
    let r = rng() * totalW;
    for (let w = 1; w <= WEEKS; w++) { r -= weights[w - 1]; if (r <= 0) return w; }
    return WEEKS;
  };
  for (const g of games) {
    g.week = drawWeek();
    grid[g.home][g.week]++; grid[g.away][g.week]++;
  }
  const conflicted = (g) => grid[g.home][g.week] > 1 || grid[g.away][g.week] > 1;

  let cost = 0;
  for (const id of ids) for (let w = 1; w <= WEEKS; w++) cost += Math.max(0, grid[id][w] - 1);

  for (let it = 0; it < 400000 && cost > 0; it++) {
    const g = games[Math.floor(rng() * games.length)];
    if (!conflicted(g)) continue;

    grid[g.home][g.week]--; grid[g.away][g.week]--;
    let best = [], bestScore = Infinity;
    for (let w = 1; w <= WEEKS; w++) {
      const sc = grid[g.home][w] + grid[g.away][w];
      if (sc < bestScore) { bestScore = sc; best = [w]; }
      else if (sc === bestScore) best.push(w);
    }
    g.week = best[Math.floor(rng() * best.length)];
    grid[g.home][g.week]++; grid[g.away][g.week]++;

    cost = 0;
    for (const id of ids) for (let w = 1; w <= WEEKS; w++) cost += Math.max(0, grid[id][w] - 1);
  }
  if (cost > 0) return null;

  // With no double-bookings, each team's single free week is its bye. Nudge
  // any that landed in week 1 or the closing stretch into the normal window.
  const byeOf = (id) => {
    for (let w = 1; w <= WEEKS; w++) if (grid[id][w] === 0) return w;
    return null;
  };
  const move = (g, w) => {
    grid[g.home][g.week]--; grid[g.away][g.week]--;
    g.week = w;
    grid[g.home][w]++; grid[g.away][w]++;
  };
  for (let pass = 0; pass < 4; pass++) {
    for (const id of ids) {
      const b = byeOf(id);
      if (BYE_WEEKS.includes(b)) continue;
      let fixed = false;
      for (const target of shuffle(BYE_WEEKS, rng)) {
        const g = games.find((x) => (x.home === id || x.away === id) && x.week === target);
        if (!g) continue;
        // Simple case: the opponent is also free during our bye week.
        if (grid[g.home][b] === 0 && grid[g.away][b] === 0) { move(g, b); fixed = true; break; }
        // Otherwise swap weeks with an unrelated game, which frees the slot.
        const partners = shuffle(games.filter((h) => h.week === b
          && h.home !== g.home && h.away !== g.home && h.home !== g.away && h.away !== g.away), rng);
        for (const h of partners) {
          const gFreeAtB = grid[g.home][b] - (h.home === g.home || h.away === g.home ? 1 : 0) === 0
            && grid[g.away][b] - (h.home === g.away || h.away === g.away ? 1 : 0) === 0;
          const hFreeAtT = grid[h.home][target] === 0 && grid[h.away][target] === 0;
          if (!gFreeAtB || !hFreeAtT) continue;
          move(h, target); move(g, b);
          fixed = true; break;
        }
        if (fixed) break;
      }
    }
  }

  const byes = {};
  for (const id of ids) byes[id] = byeOf(id);
  return { games, byes };
}

/** Build a full season. Retries until every constraint is satisfied. */
export function makeSchedule(seed) {
  for (let attempt = 0; attempt < 40; attempt++) {
    const rng = mulberry32(hashSeed(`${seed}:sched:${attempt}`));
    const matchups = buildMatchups(rng);
    if (!matchups || matchups.length !== 272) continue;
    const assigned = assignWeeks(matchups.map((g) => ({ ...g })), rng);
    if (!assigned) continue;
    return {
      byes: assigned.byes,
      games: assigned.games
        .map((g) => ({ id: `w${g.week}-${g.home}-${g.away}`, week: g.week, home: g.home, away: g.away }))
        .sort((a, b) => a.week - b.week || a.home.localeCompare(b.home)),
    };
  }
  throw new Error('could not build a valid schedule');
}

/* ---------------------------------------------------------------- standings */
export function standings(results, teams = TEAMS.map((t) => t.id)) {
  const rows = Object.fromEntries(teams.map((id) => [id, {
    id, w: 0, l: 0, t: 0, pf: 0, pa: 0,
    divW: 0, divL: 0, confW: 0, confL: 0, beat: new Set(),
  }]));

  for (const r of results) {
    if (!r.final) continue;
    const h = rows[r.home], a = rows[r.away];
    if (!h || !a) continue;
    h.pf += r.homeScore; h.pa += r.awayScore;
    a.pf += r.awayScore; a.pa += r.homeScore;
    const sameDiv = divisionOf(r.home) === divisionOf(r.away);
    const sameConf = confOf(r.home) === confOf(r.away);
    if (r.homeScore === r.awayScore) {
      h.t++; a.t++;
      if (sameDiv) { h.divW += 0.5; h.divL += 0.5; a.divW += 0.5; a.divL += 0.5; }
      if (sameConf) { h.confW += 0.5; h.confL += 0.5; a.confW += 0.5; a.confL += 0.5; }
      continue;
    }
    const [win, lose] = r.homeScore > r.awayScore ? [h, a] : [a, h];
    win.w++; lose.l++;
    win.beat.add(lose.id);
    if (sameDiv) { win.divW++; lose.divL++; }
    if (sameConf) { win.confW++; lose.confL++; }
  }

  return Object.values(rows).map((r) => ({
    ...r,
    beat: [...r.beat],
    gp: r.w + r.l + r.t,
    pct: (r.w + r.t * 0.5) / Math.max(1, r.w + r.l + r.t),
    diff: r.pf - r.pa,
  }));
}

/** Win percentage, then head-to-head, division record, conference record,
 *  point differential. Enough to break almost every tie honestly. */
export function compareTeams(a, b) {
  if (b.pct !== a.pct) return b.pct - a.pct;
  const aBeatB = a.beat.includes(b.id), bBeatA = b.beat.includes(a.id);
  if (aBeatB !== bBeatA) return aBeatB ? -1 : 1;
  const aDiv = a.divW / Math.max(1, a.divW + a.divL);
  const bDiv = b.divW / Math.max(1, b.divW + b.divL);
  if (bDiv !== aDiv) return bDiv - aDiv;
  const aConf = a.confW / Math.max(1, a.confW + a.confL);
  const bConf = b.confW / Math.max(1, b.confW + b.confL);
  if (bConf !== aConf) return bConf - aConf;
  if (b.diff !== a.diff) return b.diff - a.diff;
  return a.id.localeCompare(b.id);
}

export function sortedStandings(results) {
  const all = standings(results);
  const byId = Object.fromEntries(all.map((r) => [r.id, r]));
  const out = {};
  for (const div of DIVISIONS) {
    out[div] = TEAMS.filter((t) => t.div === div).map((t) => byId[t.id]).sort(compareTeams);
  }
  return { divisions: out, all, byId };
}

/** Four division winners seeded 1–4, then three wild cards. */
export function seedConference(results, conf) {
  const { divisions, byId } = sortedStandings(results);
  const winners = DIVISIONS.filter((d) => d[0] === conf).map((d) => divisions[d][0]).sort(compareTeams);
  const taken = new Set(winners.map((w) => w.id));
  const wild = TEAMS.filter((t) => t.conf === conf && !taken.has(t.id))
    .map((t) => byId[t.id]).sort(compareTeams).slice(0, 3);
  return [...winners, ...wild].map((team, i) => ({ ...team, seed: i + 1 }));
}

/** Seven seeds a side. The top seed sits out the opening round. */
export function playoffBracket(results) {
  return {
    N: seedConference(results, 'N'),
    S: seedConference(results, 'S'),
  };
}

export function wildCardRound(seeds) {
  return [
    { home: seeds[1], away: seeds[6] }, // 2 v 7
    { home: seeds[2], away: seeds[5] }, // 3 v 6
    { home: seeds[3], away: seeds[4] }, // 4 v 5
  ];
}

/** Reseed each round: the best remaining seed always hosts the worst. */
export function reseed(alive) {
  const s = [...alive].sort((a, b) => a.seed - b.seed);
  const out = [];
  while (s.length > 1) out.push({ home: s.shift(), away: s.pop() });
  return { games: out, bye: s[0] || null };
}
