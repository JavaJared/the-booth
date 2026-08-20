# The Booth

Two coordinators, one team, one head-coaching job. The Booth is a browser-based
football management game with live play calling, full seasons, playoffs, roster
management, a coaching carousel, scouting, a draft, and a play designer.

Email/password accounts keep up to five active season saves in Firestore, so a
career can resume on another device. Exhibition games can still be played
without an account.

### Importing a browser-only season

After signing in on the browser that contains an older `booth:season` local
save, the coaching office shows **Import Existing Season**. The import creates
and verifies a Firestore save slot before offering to remove the original local
copy. Keep that device copy until the dashboard confirms the import. Starting
or resuming an account season no longer overwrites the legacy key.

## Play it right now, no setup

```bash
cd the-booth
npx serve public        # or: python3 -m http.server -d public 8000
```

Open the page, choose **Play an exhibition without an account**, then click
**Single exhibition game, both seats here**. Everything runs in the
browser against the real engine — no Firebase, no accounts. Use **View: offense /
defense** in the call panel header to see the idle-coordinator side.

Play a full game before you build anything else. If calling ~120 snaps isn't
fun, no amount of draft logic will save it.

## Deploy from GitHub to Netlify

You never need npm on your own machine — Netlify installs everything on theirs.

### Just the single-device version (5 minutes, no accounts)

Push the repo, then in Netlify: **Add new site → Import from Git**, pick the repo,
and accept the settings from `netlify.toml` (no build command; publish
`public`). That's it. The site works immediately in single-device exhibition
mode. Skip everything below until you want real two-player.

### Two-player

Realtime sync needs a database. Firestore is the least work here, and none of it
requires a CLI — the Firebase console does all of it in the browser.

1. **Firebase console** → create a project → **Build → Firestore Database →
   Create database** (production mode).
2. **Build → Authentication → Sign-in method** → enable both **Email/Password**
   (for cross-device accounts) and **Anonymous** (for guest exhibitions).
3. **Firestore → Rules** tab: paste the contents of `firestore.rules`, Publish.
4. **Project settings → General → Your apps → Web (`</>`)** → register an app →
   copy the config object. Create `public/firebase-config.js` from
   `firebase-config.example.js`, paste it in, and commit it. These keys are
   public by design; the rules are what protect the data.
5. **Project settings → Service accounts → Generate new private key.** This
   downloads a JSON file. It is a real secret — do not commit it.
6. **Netlify → Site configuration → Environment variables**, add three from that
   JSON:

   | Key | Value from the JSON |
   |---|---|
   | `FIREBASE_PROJECT_ID` | `project_id` |
   | `FIREBASE_CLIENT_EMAIL` | `client_email` |
   | `FIREBASE_PRIVATE_KEY` | `private_key` — paste it whole, including the `-----BEGIN` line |

7. Redeploy. One player clicks *Start a game* and sends the code; the other joins.

Every file you need is already in the repo — `netlify.toml` wires the build,
and `netlify/functions/api.js` is the server.

### Where the trust boundary sits

- **Reads** go straight from the browser to Firestore over `onSnapshot`. That's
  what makes it feel live, and `firestore.rules` denies all client writes.
- **Writes** go to `/api`, the Netlify function, which is the only thing holding
  the service-account key. It picks the CPU's call, rolls the result, and writes
  it. A player with devtools open cannot learn the CPU's call before committing,
  and cannot give themselves a touchdown.

First request after idle has a cold start of roughly a second. If that gets
annoying mid-drive, Netlify's background-function warming or a paid plan fixes
it — but at 45 seconds per snap you probably won't notice.

## How it's put together

```
public/shared/    shared browser/server simulation and season logic
  playbook.js     21 offensive concepts, 20 defensive calls, all matchup data
  engine.js       pure deterministic sim: edges, resolution, clock, CPU brains
  gameflow.js     the turn loop
netlify/functions/api.js   the server: thin wrappers around gameflow
functions/        the same server as Firebase Cloud Functions, if you ever
                  move off Netlify — ignore it otherwise
public/           client; identical game UI over a Firebase or in-memory transport
tools/balance.js  simulates N games and checks the output against real football
```

**The client never resolves a play.** It submits a call; the Cloud Function picks
the CPU's call, rolls the result, and writes it. Both clients see it via
`onSnapshot`. A player with devtools open can't learn the CPU's call before
committing, and can't write themselves a touchdown — `firestore.rules` denies all
client writes.

**Two RNG streams per snap.** `hash(gameId:cpu:N)` picks the CPU's call;
`hash(gameId:play:N)` rolls the outcome. That separation is what lets *Read keys*
tell you the truth about the upcoming call without disturbing the result.

## What's in the loop

- **Call sheet** — grouped by situation, grease-pencil mark on your pick.
- **Fourth down** is a real decision: punt, field goal (with the actual make
  probability for that distance), or stay on the sheet and go for it.
- **Tempo** (chew / normal / hurry) changes real seconds off the clock.
- **The idle coordinator** predicts the CPU's next call — offense guesses the
  play family, defense guesses man/zone/blitz. A hit banks a film point.
- **Film points** (3) buy *Read keys*: a truthful partial tell before you commit.
- **Tendencies** are charted by down and distance. Get predictable and the
  defense leans the right way — the booth feed tells you when you've been read.
- **Pause** is a proposal, not a command: your rival has to accept, and then
  both of you ready up to restart.

## Tuning

```bash
npm run balance
```

Simulates 500 games and prints every rate against its real-football target.
Current state — 13 of 15 metrics in range:

| | sim | target |
|---|---|---|
| Yards per play | 5.46 | 5.3 – 5.7 |
| Completion % | 66.8 | 63 – 67 |
| Yards per carry | 4.58 | 4.2 – 4.6 |
| Sack rate | 6.8% | 6.0 – 7.5% |
| INT rate | 2.5% | 2.0 – 2.6% |
| Third down | 40.8% | 38 – 42% |
| Explosive (20+) | 5.4% | 4.5 – 6.0% |
| Points/game (both) | 38.6 | 43 – 47 |
| Run/pass split | 36% run | 41 – 45% |

The two misses are both CPU-vs-CPU artifacts — a symmetric optimizer calls a
little more pass and scores a little less than real coordinators. Raise `mean`
values in `playbook.js` to lift scoring; the run share moves with the `PRIORS`
table in `engine.js`.

Two knobs worth knowing:

- `cpuDefensiveCall(..., temp)` — softmax temperature. Lower makes the CPU a
  sharper optimizer. At `0.055` it strangled the run game; `0.105` is the
  current setting. This is your difficulty slider.
- `tendencyRead()` in `engine.js` — how hard predictability is punished.

## Two things the tuning pass caught

**The CPU offense was reading its own tendencies.** It picked plays from a
distribution it then wrote back into, so by the second quarter one family
drowned out everything else. Tendencies are for the *defense* to read.
`cpuOffensiveCall` deliberately uses the situational prior instead.

**Deep shots were strictly dominant** — PA Deep Shot returned double any other
call, so the optimal human strategy was to spam it. Deep-ball completion is now
~38% with a real sack and interception cost, and two-high shells punish it hard.
The best call is now within ~30% of the tenth-best, which is where you want it:
the edge comes from matching the coverage, not from finding the magic play.
