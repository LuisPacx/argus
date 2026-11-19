# Moment scanner: turn the Operator's manual X scans into a shortlist

Status: draft for Operator review. Written 2026-11-19. Design and documents only; nothing here is built. The Operator chose this as item 1 of `.scratch/research/petal-dev/game-plan.md` (untracked in the main checkout) and approved amending ADR 0009 and ADR 0013 for it. Terms follow `GLOSSARY.md`; new terms (Moment, Watched topic) are added there. Anything marked **(proposal)** is my number or choice, not a decision. Tickets: `.scratch/moment-scanner/issues/`. Amendments: ADR 0009 and ADR 0013 (2026-11-19).

## 1. The problem, with evidence

The best meme-coin ideas of 2026-11-19 were found by hand, by an agent session that opened X through the Argus Chrome profile roughly every hour from 05:36 to 15:20 UTC (`.scratch/research/gta6-post-release.md`, ten scans, about 13 page loads and 4 minutes each). The method worked. It also had three weaknesses, all visible in that file:

1. **It is late.** A scan only records a moment when it is already over the bar. Posting time to first "qualifying" record, from the scan notes:

   | Moment | Posted (UTC) | First recorded as qualifying | Lag | A coin already existed? |
   |---|---|---|---|---|
   | Furries illegal in Leonida | 05:15 | 12:15 scan | 7 h 00 | FURVERTS created 12:14 ($27K) |
   | Old lady and the mobility scooter | 05:39 | 13:08 scan | 7 h 29 | GTAG 06:15 (small), Boomazoom 09:19 |
   | IShowSpeed and the giant (Hulk) | 09:50 | 13:08 scan (168K views, below the bar, at 12:15) | 3 h 18 | HULK coins 12:04 to 12:06 |
   | Area 51, freed the alien | 10:17 | 15:20 scan (148K views, below the bar, at 13:55) | 5 h 03 | AL created 13:47 |
   | Paul Walker's Eclipse, Fat Jason, no car theft | 11:15 to 11:55 | 15:20 scan | 3 h 25 to 4 h 05 | none above $7K |

   For two of the five moments that produced a coin above $20K (Hulk, alien) the first coin was made before the manual scan had recorded the moment as qualifying; for the furry moment the coin came 6 minutes after the post was read. "First recorded" is the first scan that listed it, not the first moment it could have been flagged, so these lags are an upper bound; a 15 to 30 minute scanner would cut them but I cannot say by how much until the replay (ticket 07) runs.

2. **It misses rises that average rates hide.** The brief flags 50K views per hour since posting. FelpsCrypto's Area 51 clip had 148K views at 13:55 (about 41K an hour on average, under the flag) and 638K at 15:10, a gain of about 390K an hour between the two scans. A scanner that stores each reading can compute that second rate; a once-off hand scan could not.

3. **Its "taken" check was wrong once, and it cost an idea.** At 13:08 the scooter idea was dropped as taken because DexScreener showed $131K and $130K clones. The naming research at 15:00 (`.scratch/research/gta6-naming-lessons.md`, section 1) found those were Meteora bonding-curve snapshots, each followed by a pool with $2 to $4 of liquidity and a price of -100 percent: drained, not a live market. The real coins sat at $2K to $4K. A rule that reads liquidity, not headline cap, would have kept the idea open. The same file shows who won: the coin with the obvious plain name for a clip that already had millions of views (CDOG 12 minutes after its clip; AL and HULK 2 to 4 hours after theirs), not the first coin.

The hand method also costs an agent session per scan and depends on one person remembering to start it. The game plan's judgement (item 1) stands: speed is not the whole edge, so a scan every 15 to 30 minutes is enough; real time is not needed.

## 2. What a Moment is

A **Moment** is one concrete thing that happened inside a Watched topic and is spreading on X: a clip, an easter egg, a character, a glitch, an in-game object (the old lady on the mobility scooter, the alien at Area 51, the Hulk). It is found by plain counting on X posts, before any token for it is required to exist. It is stored with its best post link, its counts and rates over time, a kind and a plain subject written by the model, and a coin-side state from DexScreener (open, contested or taken).

What it is not:

- Not a **Meta**. A Meta is led by a token at $1,000,000 and is observed on the market; a Moment is led by attention on X and usually has no coin yet. A Moment can later sit under a Meta (the GTA VI Meta), and a Meta's label can be the topic a Moment is found in.
- Not a **Signal**, **Source** or **Narrative**. The scanner is not a Source (ADR 0009 already says X produces no Signals), so ADR 0011 does not apply: a Moment never enters clustering, never feeds the judge, and never starts a Proposal by itself. It starts one only when the Operator presses a button (section 6), or, in the later full version, under its own switch and cap.
- Not advice. A Moment says "this is moving and here is what the coin side looks like", not "launch this".

A **Watched topic** is a subject the scanner searches X for: a label, its search spellings, and a start time (posts before it are ignored). It comes from a current Meta or Watching subject, or from the Operator.

## 3. How the scanner works

The split follows how argus works today (ADR 0009, ADR 0012, ADR 0014): plain code counts and applies thresholds; the model is used only where judgement is needed and sees only saved text, never a browser.

| Step | Who | What |
|---|---|---|
| Find | Code (Playwright child process, no Claude) | Search X for each topic, read posts, record counts |
| Qualify | Code | Apply the bars, compute rates, group posts, dedupe |
| Judge | Model (`moment-judge`, sonnet, no tools) | Is it a concrete thing; what kind; what do people call it; flags |
| Trace | Code (DexScreener, existing client) | Find coins that ride it; decide open, contested or taken |
| Ideas | Model (`meme-ideas`, existing) | Three names and hooks, only when the Operator asks |

### 3.1 Find

For each active topic the scanner builds its search queries by code from the topic and a fixed list of operators (never from free text; see 3.7) and loads them in the dedicated logged-in browser (ADR 0009 as amended), one process, serial, jittered:

- **Spellings (the manual group A):** one query that ORs the topic's spellings, Top tab, `since:<topic start>`, `min_faves:2000`. Surfaces posts that are already big. One load covers all spellings: the manual scan used seven loads for seven spellings, and X search accepts OR.
- **Rising clips (the manual group B):** the same spellings, `filter:videos`, `min_faves:500`, Top and Latest tabs. Surfaces videos still on the way up.
- **Re-reads:** a Moment already tracked whose best post did not appear in this scan's results is re-read from its own post page, at most 2 a scan, so its counts keep a time series.

Posts are read from bare `article` elements (the X page no longer carries `data-testid="tweet"`; `.scratch/research/gta6-post-release.md`, scan 07:21) and counts from the action-row aria-label ("44 replies, 39 reposts, 185 likes, 4 bookmarks, 18856 views"). The post time is decoded from the status ID, which is exact to the second (status 2123280111864811617 is 05:00:01 UTC on 2026-11-19), because search results show no time element. Views are sometimes not shown; a missing figure stays missing and is never read as zero. A page where the selectors find nothing is a status of its own ("selectors found nothing"), not "ok with zero posts". The same stop rule as the Study applies: a login wall, challenge, lock, suspension or rate-limit text ends the scanner's day with no retry and notifies the Operator.

### 3.2 Qualify (the numbers, all in code)

Defaults, from the brief the hourly scans use unless marked **(proposal)**. All are in one config file and tested; the model never sees them.

| Rule | Value |
|---|---|
| Only posts created at or after the topic's start | the topic's `startsAt` (GTA VI: 2026-11-19 05:00:00 UTC). A post quoting an older post is flagged "older origin" |
| Qualifying, test 1: best post | at least 200,000 views or 5,000 likes |
| Qualifying, test 2: spread | at least 3 distinct accounts, each at least 20,000 views, in one Moment |
| Rising | at least 50,000 views an hour since posting, and under the bars above (the "rising only" list of the 15:20 scan) |
| Rate floor **(proposal)** | a post must be at least 30 minutes old and have at least 20,000 views before a rate counts, so a 10-minute-old post with 10K views is not "60K an hour" |
| Recent rate **(proposal)** | views gained since the previous reading, per hour, also flags at 50,000 an hour. This is the FelpsCrypto case in section 1 |
| Missing views **(proposal)** | a post with no views shown qualifies only on likes (5,000), never on a guess |

A Moment has a tier: `rising`, `qualifying`, or `cooling` (it was flagged and its recent rate has fallen under 5,000 an hour for 6 hours). Tier only goes up on evidence and is recorded with the time of each change, because lead time (section 9) is read from those times.

**Grouping posts into a Moment** is needed because the spread test counts accounts and the old-lady clip was posted by several. Code groups first: quote-tweets of a member join it, and posts whose text is close under the in-process embedder (ADR 0007) join it above a conservative similarity threshold **(proposal; ticket 02 tunes it on the fixture set)**. The model then confirms or splits groups when it judges (3.3). A group that code cannot place alone is a Moment of one post.

**Dedupe.** A Moment's id is fixed by its earliest member post. A new post that groups with an existing Moment joins it; it never creates a second row. A Moment already seen is flagged again only when its tier rises (rising to qualifying) or it grows by a set factor **(proposal: 3x views since the last time the Operator saw it)**, shown as "grown", which is the manual scans' "GROWN" label. The Operator can ignore a Moment; an ignored Moment stays hidden whatever it does.

### 3.3 Judge (model, one cheap run per change)

The model is called only when the scan has a new or materially changed Moment (a new qualifying group, a tier change), never for posts under the floors. One run takes the Moment's top few posts as a fenced block of untrusted text (the posts were written by strangers) plus the topic, and returns one JSON object: whether the group is one Moment or should be split, a kind, a plain subject, up to four search phrases people would use for it, and flags.

Kinds, to carry the manual notes' "not qualifying" rules: `moment` (a concrete thing in the topic), `reaction` (a streamer or fan reacting to a concrete thing; it counts, as the Hulk case did), `news`, `opinion`, `brand` (a studio or company post, such as the Cyberpunk congratulation), `other`. Only `moment` and `reaction` with a nameable subject stay on the main list. The rest go to a folded "not a moment" list with the reason, so the Operator can override a wrong call. This is where "post-release gameplay only" becomes "a concrete thing in this topic, not news, opinion or a brand post".

Flags the model sets, kept in the Moment (the manual risk lines turned into fields): `real person`, `nsfw`, `political`, `trademark`, `unverified claim`, `clip not viewed`. The last is always set: the model reads captions and counts, not the video (as in the 13:08 scan, where the giant clip was "not opened"). The Operator opens the link.

The model's search phrases are not trusted either: code limits them to letters, digits and spaces, 1 to 4 words, at most 4 phrases, and uses them only as DexScreener search text and as name-match words.

Cost control: its own cap (24 runs in any rolling 24 hours **(proposal)**), taken from the research budget, not added to it, like the meme cap (ADR 0013). A refused or failed run is retried once a scan later, then left unjudged and shown as such.

### 3.4 Trace (coin side, code only)

For each judged Moment, on every scan while the Moment is live (24 hours after its last flag), code searches DexScreener (the existing read-only `DexScreenerClient.search`) for each phrase and keeps Solana pairs that:

- match by name or ticker: every word of a phrase appears in the normalised name, or the ticker equals the phrase squashed together ("jet ski dog" and JETSKI);
- were created at or after the Moment's earliest post (an older coin, such as GIANTS at 900 hours old, is not riding it; the name-copy check in `meme-ideas` still refuses a copy of any existing name).

Each pair is then classed by the **taken check**, section 5. The Moment's coin-side state is the worst of its clones: `open`, `contested` or `taken`. The scan also records the first time a real clone reached $50,000 (section 9 reads it).

A second, reverse view arrives later (ticket 09): the top coins of the topic by market cap, each matched to the Moment it rides or marked "no moment" (the manual scan's "coin-side top list": Rockstar Games $943K rides the release, not a moment; HULK rides the Hulk clip).

### 3.5 What the scanner stores

The scanner writes only to its own tables in the worker's database (posts and their counts over time, Moments with tier history, traces, topics, judge results). The War Room reads them through its read-only view and may write only two things: a request row asking for ideas (section 6) and an Operator topic or "ignore" mark. It never writes a Proposal (CODING_STANDARDS rule 1).

### 3.6 Behaviour when things fail

- X is off, locked or the browser is busy (the Study or the Operator holds the directory): the scan is skipped and says why; nothing is retried in a loop. The War Room shows the state and the time of the last good scan.
- DexScreener fails: the Moment's state is "not traced" and keeps its last good trace; it is never read as open because nothing came back (the same fail-closed rule as ADR 0015's verification).
- The model fails or the cap is used: the Moment stays on the list with its numbers and "not judged yet".

### 3.7 Untrusted input

Every post, handle, caption and token name is third-party text. Rules, all already used elsewhere in argus: text is cut and flattened before storage; it reaches the model only in a fenced block with a fresh random boundary and no tools; the War Room renders it as text, with links only through `safeHttpUrl` and only to `x.com` and `dexscreener.com`; nothing builds a RegExp from it; the worker never fetches a URL from a post. **Query text is the new risk**: a topic label that came from a Meta (created from token names) or from the Operator must not be able to add X search operators (`from:`, `filter:`, `-`, `min_faves:`). Queries are built by code from words limited to letters, digits, spaces and a few marks, with the operators coming only from a fixed list.

## 4. Topics

Topics come from two places and are capped.

- **From Metas.** Every current Meta (at most 3) is a topic, labelled and spelled by code from the Meta's label and the labels of its merged launch themes ("GTA VI", "Lucia", "Vice City" for the GTA VI Meta). Spelling variants are added by plain rules: a roman numeral and its digit (GTA VI and GTA 6), no-space form (GTA6), hashtag form (#GTA6). The start time is the Meta's entry time minus 24 hours **(proposal)**. Watching subjects are off by default **(proposal)**: they are weaker evidence and cost loads; the Operator can switch them on. A topic stays active for 24 hours after its Meta leaves.
- **From the Operator.** A small form on the Moments page: a label, up to 6 spellings, an optional start time, and an expiry of 7 days unless renewed **(proposal)**. This is how a topic with no Meta yet (the case that matters most) gets watched, and how the Operator carries over his "post-release only" rule: the start time.

At most 4 topics are active **(proposal)**. When more are due than the load caps allow, Metas go first, then the Operator's by oldest scan. A topic that finds nothing for 6 scans in a row is scanned at half the rate until something flags **(proposal)**.

Generalising from GTA VI: nothing in the code says GTA. What the manual brief hard-coded (the seven spellings, "post-release gameplay only", the 200K and 5K bars) becomes a topic's spellings, its start time, and the global bars. A topic type with different bars (a sports event, a launch) is not designed here; one set of bars is used until the replay shows a topic where it fails.

## 5. Naming and the taken check

**Naming** is not new work. `.claude/skills/meme-ideas/SKILL.md` already carries the naming rules from `gta6-naming-lessons.md` (plain words people use, the in-game proper name as ticker, a description over a pun, 1 to 3 words, no suffixes), shipped in commit 383b26f (Meta redesign ticket 15). The Moment path adds two inputs the skill can use: the model's search phrases from the judge (the words people typed about the clip) and the traced clones' names, which go into the "names to avoid" list so the existing copy check rejects them. The skill's own caveat applies: the evidence is one day and 1 to 3 coins per pattern.

**Taken check** (code, DexScreener, per pair). A pair is a **real clone** only if all of these hold:

1. Liquidity of at least $5,000.
2. Market cap of at most 100 times its liquidity (the brief; it is the same ratio test as `fakeTestFailures` in `meta/topdown.ts`, whose Meta threshold is stricter at $50,000 minimum liquidity, so the Moment check has its own smaller floor, **(proposal)** kept in `moments/config.ts`).
3. Priced: a pair with no figures is skipped as "unpriced" (Meta redesign ticket 14), never read as zero.

Anything that fails is a **lookalike**, kept in the list with its reason ("pool $4, cap $131K: drained or fake") so the Operator sees what looked taken and was not. This is the Boomazoom case in section 1.

Coin-side state of the Moment: `taken` if any real clone has a market cap of $50,000 or more (the manual rule "a clone is above $50K"); `contested` if there are real clones below that; `open` if there are none. State changes are timestamped. The Moment stays visible when taken; the manual scans "dropped" it, but a Moment someone else has already won is still information (and the Vamping term in the GLOSSARY covers the case the Operator may want). Choosing to skip it stays his call.

## 6. How ideas reach the Operator

Reuse the meme-ideas path; add one source.

- **War Room.** A new page `/moments` lists live Moments per topic: tier (qualifying or rising, with "grown"), best post (link, views, likes, views an hour), kind and subject, flags, coin-side state with the biggest real clone and the lookalikes, and age. A strip on `/` shows how many are qualifying and links in. The page is text only.
- **Button.** "Make ideas" on a Moment writes a request row (insert only, like Operator angle requests, ticket 11 of Meta redesign) and nothing else. The worker runs the `meme-ideas` path with a Moment block in place of the Meta block (the post text and counts as untrusted data, the topic, the traced clones as names to avoid, the Meta's own tokens too when the topic came from a Meta) and files three ordinary `meme` Proposals. They carry a link to the Moment's best post and its numbers on the Proposal page, and have the usual 12-hour life, Shortlist and Dismiss, no Spec, no Build, no score (ADR 0013).
- **Why not a new kind.** See the ADR 0013 amendment: a Moment idea is a `meme` Proposal with a moment source (a fourth, beside a Meta, a news story and the Operator's angle). Recommended because every behaviour the idea needs already hangs off `kind = 'meme'`, and a new kind would touch each of them for no new behaviour.
- **Caps.** An Operator-pressed request counts in the existing allowance for angle runs (5 in any rolling 24 hours, one waiting, the same request refused for 24 hours), and in the research budget. Nothing about the caps loosens.
- **Later (ticket 11, full version).** Automatic ideas for a qualifying, `open` Moment, under their own switch and a daily cap of their own **(proposal: 4)**, and a Telegram message when a Moment first qualifies. Not before the live scorecard (section 9) says the flags are worth a message.

## 7. Cadence and cost

**X load, on the one logged-in profile.** About 3 page loads for a topic's scan (one spellings search, one video search on Top and one on Latest) plus up to 2 re-reads. One topic every 30 minutes is about 48 scans and 144 to 240 loads a day. Caps, all in code, lowerable and never raised by configuration:

| Cap | Value **(proposal)** |
|---|---|
| Loads per scan | 8 |
| Loads per hour | 24 |
| Loads per day for the scanner | 300 |
| Scrolls per page | 3 (about 20 to 40 posts) |
| Gap between loads | 9 to 22 seconds, jittered (the spike's pacing) |
| Minimum scan interval per topic | 15 minutes; default 30 |

The Study's X capture has its own 200 a day (ADR 0009), so the profile could see about 500 loads a day. That is 2.5 times what the spike was designed around and the spike only tried 12 loads. **Start the scanner at 100 loads a day for the first week** and raise it by hand only if no wall appears (ticket 08). The Operator must accept this extra exposure; it is the first open question (section 11). One process owns the browser directory at a time, so the scanner, the Study's capture and the Operator's own Argus Chrome session queue behind one lock; the scanner skips a scan when the lock is held rather than waiting.

**Brain spend.** Judge runs (cap 24 a day) are short: a few posts in, one small object out. The one-off Operator-angle ideas run cost $0.0377 on sonnet (Meta redesign ticket 11), so a judge run of similar or smaller size is about $0.02 **(estimate; ticket 03 measures it)**, about $0.50 a day at the cap, against a default research budget of $6. Ideas runs are the Operator's and are already capped at 5 a day. Spend is Est. usage on the subscription, shown apart from real dollars (GLOSSARY). A cheaper model for the judge is a measured option after the replay, not a starting choice.

**DexScreener.** One search per phrase per Moment per scan, through the existing client with its retry and backoff; at most 10 searches a scan **(proposal)**.

## 8. What stays manual

- The Operator launches. Argus never launches, signs or holds a key (ADR 0002 untouched): a Moment idea is text, and the image idea is text.
- The Operator presses "Make ideas", reads the clip, sets topics and the start time, and decides. In the first version nothing is automatic past the shortlist.
- Re-logging in to X after a wall, and any use of the Argus Chrome profile by hand, stay the Operator's (the scanner refuses to start while he holds it).
- Posts, likes, follows and messages: none, ever (architecture invariant 6). Navigation is search and post pages only, by URL.
- Judging the clip itself. The model reads captions and counts; whether the video is what it says is for the Operator.

## 9. Measurable success

Targets are proposals, set before the data exists. The thresholds were chosen by hand on one day, so the replay flatters them; the live numbers are the real test.

- **Replay on 2026-11-18 and 19 (ticket 07, no live X needed).** Input: every post and count in the scan notes, as dated readings. Of the five moments that produced a coin above $20K (dog, alien, Hulk, scooter, furry), the game plan's bar is that the scanner's rules flag at least 4 before the winning coin is created. **I expect the notes alone to fall short of it**, and say so now so a short result is read as a data limit and not as a failure of the rules: the notes hold readings only at manual scan times, so the replay can show no earlier flag than the first reading. The alien coin (13:47) came before the first reading of its clip (13:55); the HULK coins (12:04) before the first reading of the giant post (12:15); the dog coin 12 minutes after its clip, inside any cadence. The replay therefore gives an upper bound on lateness and reports the number it finds; it cannot measure false flags on posts nobody recorded, and it is no reason to change a threshold. The live numbers below are the test.
- **Moments found before the first $50K real clone.** For a Moment that gets a real clone (section 5) of $50,000 or more within 24 hours of its flag: the share where the scanner's first flag is earlier than that clone's pair creation time. Target after 2 weeks live: at least 60 percent, with the count shown so a small n is visible.
- **Lead time against the manual scans.** For Moments both found: scanner first flag minus the manual scan's first record (the table in section 1 gives the manual side; the manual scans keep running with the same thresholds for the comparison, game plan step 5). Target: the scanner is earlier by a median of at least 60 minutes.
- **Precision and noise (the game plan's numbers).** At most 10 false flags a day (a flagged Moment the Operator ignores or the judge calls not a moment); at least 40 percent of flagged Moments followed within 24 hours by a coin above $20K with at least $10K pool liquidity.
- **Usefulness.** How many Moments the Operator turned into ideas, how many of those ideas he shortlisted, and how many launches he marks from them. The Operator's own launch outcomes already come from chain (ADR 0002 amendment).
- **Cost.** Loads per day against the cap, judge runs and Est. usage per day, and any wall or challenge (target: none).

Ticket 07 builds the replay and puts the live scorecard on the Moments page.

## 10. Risks and what we do not know

- **X's terms forbid this** and the account can be locked, which also stops the Study's X fields. ADR 0009 accepted that for the Study at about 200 profile loads a day; search-driven scanning at 2 to 3 times the load is a bigger and different exposure. Mitigations: ramp, caps, stop on the first signal, one lock, read-only. A second account for the scanner would isolate the risk; it is an open question, not assumed.
- **X's markup changes.** It already did once. The reader is tested on saved real pages, reports "selectors found nothing" distinctly, and stops rather than guessing.
- **A Moment is not demand.** The biggest GTA 6 posts were news or already taken; the biggest coins were launcher-driven. The qualifying bars say "spreading", not "will pay". Hence the open, contested and taken states and the success measure that waits for a real clone.
- **Counts cannot be replayed from history.** X does not give past counts, so the replay uses the manual scans' readings; live recording is the only way to get real series, which is why the scorecard runs for two weeks before the full version.
- **One day of evidence.** The bars, the 100x ratio and the naming rules all come from the GTA VI release day.
- **Model blind spot.** The judge reads text. Videos, image posts and a Turkish caption about a clip it cannot see are judged on words.
- **Browser-only evidence of coin age.** DexScreener's pair creation time is the pair's, not the token's; a token that migrated looks newer. Treated as a known imprecision in the lead-time figure.
- **Not tested here.** I did not open X, DexScreener or any live page for this spec; everything about the live sites is taken from the scan notes and the spike's outcome note (`.scratch/phase-3-feedback/issues/05-outcome.md`).

## 11. Open questions for the Operator

1. **X exposure.** Is the scanner allowed on the same Argus X account as the Study, at 100 loads a day for a week and then up to 300, or should it have a second account and Chrome directory? (Recommended: same account for the first week, as above; a second account if any wall appears.)
2. **Watching subjects as topics** (off by default), and the cap of 4 active topics.
3. **Start time for a Meta topic.** Meta entry minus 24 hours is a proposal; the GTA VI case wants the release time. Should the Operator always set it, or is the default enough?
4. **Automatic ideas and the Telegram nudge** (ticket 11): wanted at all, and the daily cap of 4.
5. **Judge model.** Sonnet to start; ask for a haiku comparison after the replay?

## 12. Slices

Each ticket is one thin vertical slice and says what is useful on its own. Order of value:

| # | Title | Model | Blocked by |
|---|---|---|---|
| 01 | Rising clips for one topic, shown in the War Room | sonnet / high | none |
| 02 | Qualifying bars, grouped Moments, dedupe and growth | sonnet / medium | 01 |
| 03 | The moment judge: kind, subject, phrases, flags | sonnet / medium | 02 |
| 04 | Coin-side trace and the taken check | sonnet / medium | 03 |
| 05 | Topics from current Metas and from the Operator | sonnet / high | 02 |
| 06 | "Make ideas" hands a Moment to the meme-ideas path | sonnet / high | 03, 04 |
| 07 | Replay on 2026-11-18 and 19, and the live scorecard | sonnet / medium | 04 |
| 08 | Cadence, load caps and one shared X session | sonnet / high | 01 |
| 09 | Coin-side list: top topic coins matched to Moments | sonnet / medium | 04 |
| 10 | Architecture doc and pipeline graph lines | haiku / low | 06 |
| 11 | Automatic ideas and a Telegram nudge (full version) | sonnet / high | 06, 07, 08 |

Ticket 01 is useful alone: the Operator gets a War Room list of fast-rising clips for one topic from one config line, with the whole scan, store and page behind it. After that the order is a choice: 02 and 03 make it a shortlist; 04 makes it a tool for deciding; 05 and 08 make it general and safe to run all day.

## 13. Not in this spec

- Anything that launches, signs or spends (ADR 0002).
- Using X data as Signals, in Narratives or in the Rubric (ADR 0011, ADR 0009).
- The feed blind spot, the caller-wallet shadow watch, dev share and the quote-token analysis (game plan items 2 to 5).
- Video or image understanding. A later option, if the judge's text-only calls prove the weak point.
