# Trend radar: find new subjects before the market tokenizes them, 24/7

Status: accepted (the Operator chose Option B, built in two stages, on 2026-11-19). Written 2026-11-19. Design and documents only; nothing here is built. Terms follow `GLOSSARY.md`; new terms (Trend, Untokenized, Radar) are added there. Anything marked **(proposal)** is my number or choice, not a decision; every number marked so lives in one config file and can be tuned on the 14-day data. Evidence and prices come from `.scratch/research/trend-radar/costs-and-options.md` (untracked in the main checkout; its Option A and B sections, findings, 14-day measures and cost figures are the source here). I did not re-measure them. Decision record: ADR 0016. Tickets: `.scratch/trend-radar/issues/`.

## 1. The problem, with evidence

The Operator wants to know about a new subject (a release, an event, a character, a person, a phrase) while no token for it exists, or only dust. Argus has three finders and none does this:

1. **The news pipeline cannot, by design.** A news Narrative is judged only if it holds a market Signal and a headline (ADR 0011). A story with no coin never gets judged. On the live DB over the last 3 days about 1,070 news Narratives formed in one day, and the judge ran 12 times in three days. A radar has to be its own path, as the moment scanner is, and not a Narrative.
2. **Metas are tokenized by definition.** A Meta needs a leader at $1,000,000 and 10 distinct creators (ADR 0014). By then the subject is taken.
3. **The moment scanner finds clips inside a topic someone already named** (`.scratch/moment-scanner/spec.md`). Nothing finds the topic. Today the Operator names it by hand (GTA VI).

What the stored feed shows about the sources:

| Subject | What the feeds carried | What the market did |
|---|---|---|
| Anthropic IPO | 13 news feeds carried it on 11-05 and 11-06 | 260 pump.fun creates mentioning Claude or Anthropic started 11-06 22:00, so news led by hours to a day |
| "Clawd" | no feed ever carried it | 25 creates from 11-07 02:51 |
| The Hulk clip (IShowSpeed) | no feed carried it | HULK coins 12:04 to 12:06 on 11-19, 2.2 h after the clip |

So corporate and scheduled news is visible in RSS and Google Trends; memes are visible only where people post them, which is X. That is why the plan has two stages: free sources first, then X's official API for speed, then an automatic hand-off to the moment scanner (which reads X) for the clips.

How much time there is to win: of the five moments of 2026-11-19 that produced a coin above $20K, the winning coin came 6 and 12 minutes after the clip (furry, dog) or 2.2 to 15 hours after it (Hulk 2.2 h, alien 3.5 to 4.5 h, scooter 15 h). A detector that flags in 30 to 60 minutes has a real window on 3 of 5 and none on 2 of 5 (inferred from those times). The first coin was not the winner; the plainly named one was. The Operator's own manual scans recorded moments 3 to 7.5 hours after the post.

What stage A can and cannot do: the research expects stage A alone to have caught **none** of the five winners of 11-19 (they were X clips; inferred), and to be good for news and scheduled events (the Anthropic IPO was on RSS about 9 hours before the first matching coin). Stage A is therefore a cheap, risk-free test of whether the free sources add anything, not the whole answer. That is the point of staging.

Why not a bigger option now: topic-free X scanning in the browser (Option C) would put about 750 page loads a day on the one shared X account, 3.7 times what ADR 0009 sized and about 60 times the loads ever tried, and a lock stops the Study and the scanner too. It stays off until the 14 days show a gap only it could fill.

## 2. What a Trend is

A **Trend** is a subject (a plain, nameable thing) that one or more outside places show as new and rising, found by plain counting, usually before any token exists. It is stored with its plain subject and search phrases (written by a model, checked by code), the sources that carried it and when, a score from plain code, and a coin-side picture: DexScreener's live tokens by the ticket 16 test, plus how many pump.fun creates argus has seen under that name.

How it relates to what exists (also in the GLOSSARY):

| Term | Relation to a Trend |
|---|---|
| **Signal** | The radar's raw readings (a Google term with its traffic, a headline's words) are not Signals: they are stored in the radar's own tables, never in `signals`, never clustered. The radar is not a Source and has no entry in the Source class table (ADR 0011 does not apply, as for the Moment scanner). |
| **Narrative** | A Narrative is argus's Rubric-scored cluster of Signals that needs a market Signal to be judged. A Trend is not clustered, not scored by the Rubric, never judged by the `judge` task and never starts a Tech Proposal. A Narrative may later match a Trend; the two are not the same thing. |
| **Meta** | A Meta is led by a token at $1,000,000. A Trend is led by attention outside the market and may have no token. A subject that is a Meta or a Watching subject is not a Trend (it is dropped as already tokenized, section 5.4). |
| **Moment** | A Moment is one concrete clip inside a Watched topic on X. A Trend is the subject-level find. A Trend can become a Watched topic (Operator press, or stage B automatically), and then Moments are found under it. |
| **Watched topic** | The hand-off: a Trend becomes one, under the moment scanner's cap of 4 active topics (section 6.2). |
| **Proposal** | A Trend never creates one by itself. When the Operator presses "Make ideas" it feeds the existing `meme-ideas` path, as a `meme` Proposal with a trend source (section 6.3, ADR 0016). |

**Untokenized** is a state of a Trend: no live token (the ticket 16 test, `packages/core/src/meme/live-token.ts`) on Solana that matches its phrases, and at most 4 distinct creators among the local pump.fun creates of the last 48 hours that match its name **(proposal)**. A Trend whose coin-side check failed is `not traced`, never untokenized (fail closed, as the moment spec and ADR 0015 do).

## 3. How it works, in one view

| Step | Who | What |
|---|---|---|
| Collect | Code | Poll Google Trends rising terms (several countries), the radar's own list of news RSS feeds; stage B adds X's trend list. Store each reading with its time. No Claude. |
| Count and score | Code | Fold spellings to one key, keep a 14-day seen-set, count independent sources within 3 hours, read the speed of rise, apply thresholds. No Claude. |
| Skip | Code | Drop anything that is a current Meta, a Watching subject, or older than the seen-set allows. |
| Name and filter | Model (`radar-name`, haiku, no tools, one batch run) | Is it a concrete, nameable thing; the plain subject; up to 4 search phrases; flags (real person, nsfw, political, trademark, unverified, upcoming date). |
| Untokenized check | Code | DexScreener search for each phrase, local creates by name, the live-token test; state `untokenized`, `contested`, `taken`, `tokenizing` or `not traced`. |
| Show | Code | The War Room `/radar` page. |
| Hand off | Operator presses (stage A); code under caps (stage B) | Watch on X, Make ideas, Ignore. |

The split follows the rest of argus: plain code counts and applies thresholds; the model is used only for judgement (is it a thing, what do people call it) and sees only saved text, never a browser and never a tool.

**Untrusted text.** Every term, headline, trend name and token name is third-party text. Rules, all used elsewhere in argus: cut and flattened before storage; reaches the model only in a fenced block with a fresh random boundary, no tools, named untrusted; the War Room renders it as text with links only through `safeHttpUrl`; nothing builds a RegExp from it; no URL from a feed is ever fetched; text that reaches a search (DexScreener now, X Counts in stage B, a Watched topic's X query) goes through a cleaner that keeps letters, digits, spaces and a few marks, 1 to 6 words, and can never add an operator. The model's phrases get the moment judge's limits (letters, digits, spaces, 1 to 4 words, at most 4 phrases).

## 4. Sources

"Access" is how argus reads it; "failure" is what the radar does when it breaks. Every source has a status the page shows (`ok`, `backing off`, `format changed`, `down`) with the time of the last good poll. A source that stays `backing off`, `format changed` or `down` for more than an hour (Google Trends included) raises a banner on `/radar` and `/`, and `/radar` reads at most 100 Trends at a time. Before the first real poll the agent checks each source's terms and robots rules (the Google feed in ticket 01, each news feed in ticket 02). **An empty answer is never read as "no trends"**: zero items from a non-empty body is `format changed`, a network error or 429 is `backing off`, and neither counts as a quiet hour in the seen-set or the score.

### 4.1 Stage A (free, no X account load, no key)

| Source | Access | Rate and limits | Failure handling |
|---|---|---|---|
| **Google Trends realtime RSS**, several countries | `https://trends.google.com/trending/rss?geo=XX`, unauthenticated, the same feed `sources/google-trends.ts` reads. 10 items a poll, each with `ht:approx_traffic` ("1000+", "2000+") and news links. Today only US is polled, as a Source that makes Signals; the radar polls its own list (proposal: US, GB, CA, AU, IN, BR, DE, JP; the list is data) and makes no Signals. The official Trends API is alpha, apply-only and has no realtime endpoint, so it is not used. | No published limit (inferred: unofficial feed). One request per country every 15 minutes, 2 to 5 seconds apart, jittered. Today it gave 821 Signals and 807 distinct terms in 24 hours for the US. | Per-country backoff: doubling wait, honours Retry-After, never above 1 hour. A country that fails does not stop the others. Zero items from a non-empty body is `format changed` and shows on the page. |
| **News RSS**, a radar-only list | A new `config/radar-feeds.json` (the existing `config/rss-feeds.json` stays untouched: adding feeds there would add Signals and change Narrative clustering, whose margin is thin, `docs/architecture.md` section 13). About 30 feeds: entertainment, gaming, sport, "upcoming" (release calendars). Parsed with the existing RSS parser. The agent verifies each URL loads and its terms allow reading before it enters the list. | One GET per feed every 15 minutes, conditional (ETag or Last-Modified) where the feed supports it, a 2 MB cap and 10 s timeout as `sources/http.ts` has. | Per-feed status; three failures in a row mark the feed `down` on the page and it is retried hourly. No feed's failure blocks another. |
| **Existing launch data** (not a candidate source) | The Meta pipeline's current Metas and Watching subjects, and the stored PumpPortal creates (`pumpportal:events:create:<mint>` Signals) plus the Phase 3 chain-sourced rows in `study_tokens` (migrated creates and the daily sample) | Read from the worker's own database; no request | Used for the skip rule and the local half of the untokenized check. Their limits are stated in 5.5: PumpPortal misses about 47 percent of creates and the chain rows are a partial sample, so "few local creates" is weak evidence and the DexScreener answer carries the check. |
| **DexScreener**, the existing client | `DexScreenerClient.search`, read-only, with its retry and backoff | At most 30 searches a 15-minute tick (proposal), jittered; reported limits are 60 a minute for profiles (confirmed) and 300 for search (reported by third parties, unconfirmed) | A search that fails after its retries leaves the Trend `not traced` with its last good trace; never `untokenized`. |

Left out on purpose, with the research's reasons: Reddit (official terms not readable, new API access needs approval), TikTok (not eligible, crawler rules against us), Know Your Meme (commercial use needs authorization, documents a meme after it is big), Telegram and Discord alpha channels (announce coins that already exist, shill text), YouTube `mostPopular` (lags hours to days, needs a Google Cloud key) and Wikipedia pageviews (limits unverified). If the 14 days show the free sources are thin, Wikipedia pageviews is the first extra to test, as a later ticket.

### 4.2 Stage B (X's official API, pay-per-use)

Prices and limits read on 2026-11-19 by the research from `docs.x.com`; ticket 10 re-reads them before any code and stops if they changed.

| Source | Access | Price and limits | Failure handling |
|---|---|---|---|
| **X Trends** | One request per place (worldwide, US, UK) every 30 minutes, app-only bearer token, returns `trend_name` and `tweet_count` (posts in 24 h, shown only at 1,000 or more, up to about 10 minutes old) | $0.010 a request, 144 a day, about $1.44 a day. 75 requests per 15 minutes per app, far above the use. | 429: wait for the reset header, no retry inside the tick. 401, 402 or 403: stop the X API for the day, show it on the page, tell the Operator (a credit that ran out looks like this). 5xx or a changed body: one retry next tick, a changed body is `format changed`, never zero trends. |
| **X Counts (recent)** | One request per fresh candidate that passed the score floor, hourly buckets over the last 24 hours, query built by code from the cleaned phrases in quotes plus fixed operators | $0.005 a request, at most 200 a day (about $1.00 a day) | As above. A candidate with no answer has no X velocity; it is never scored as flat. |

The X API is not the logged-in browser: it adds **0 page loads** to the shared account and so adds no ban risk to the Study or the scanner. Search with engagement filters ($0.005 per post returned, about $360 a month for one polled query) is not used.

## 5. Detect, score, dedupe, untokenized

### 5.1 Candidates and keys (code)

- A **candidate** is one term from one source at one time: a Google term with its traffic, a headline phrase, an X trend name.
- **Key.** `radarKey` is a thin wrapper over `packages/core/src/meta/key.ts` (`aliasKey(normaliseKey(x))`: lower-case, Unicode-normalised, punctuation stripped, spaces collapsed, a roman numeral and its digit folded, so "GTA VI", "GTA 6", "GTA6" and "#GTA6" are one key). That is what "the same name" already means for Metas. The radar has no normaliser of its own, and the skip rule folds both sides (a Meta "GTA 6" skips the term "gta vi"). The moment scanner's `spellings.ts` (its ticket 05) makes search spellings for topics; it is not a key.
- **Headline phrases without a model.** For news feeds the radar counts word sequences (1 to 4 words, stop words dropped with `stopwords.ts`) across feeds and keeps one that appears in at least 3 distinct feeds within 3 hours and is not in the seen-set. Google terms are already phrases. The model never extracts terms from headlines; it only names and filters what counting already found.
- **Seen-set.** Every key keeps `first_seen` and `last_seen` for 14 days. A key not seen for 14 days and seen again is new again. Only keys new inside the window can become a Trend.

### 5.2 Score (code, all numbers in `packages/core/src/radar/config.ts`)

Points **(proposal; the 14 days tune them)**:

| Part | Points |
|---|---|
| Independent sources carrying the key within 3 hours: Google Trends in any country counts as one source, each news feed as one, X Trends as one | 20 each, up to 4 sources (80) |
| Google `approx_traffic` of 5,000 or more | +10 |
| Google `approx_traffic` of 20,000 or more (instead of the line above) | +20 |
| Carried by 3 or more Google countries | +10 |
| An upcoming date inside the next 60 days (the model's `upcomingDate`, checked by code to be a real date in range) | +10 |
| Stage B: X count doubling (last 3 hours against the 3 before, and at least 200 posts in the last hour) | +20 |

A Trend is **shown** from 40 points. It is **folded** ("already has a coin") when its state is `taken`, and **hidden** when ignored. At most 30 on the page, at most 10 new an hour. The score only orders and gates the page; it never starts a model run on its own beyond the naming batch.

### 5.3 Dedupe

- One row per key. A new reading of a known key updates the row; it never makes a second one.
- Several keys become one Trend only through the model's plain subject: when two keys get the same normalised subject, the rows merge (the earlier id wins, the others keep their keys as aliases). No embedding or clustering is used; this is plain equality on a model-written, code-checked string.
- A Trend already shown is flagged again only when its score rises by a tier (shown to strong, 70 points) or its state changes; the page shows "changed" with the time, as the moment scanner's "grown".
- A key already an active Watched topic shows a "Watched" badge instead of a Watch button.

### 5.4 Skip rule (code)

A key (or a phrase) that matches the normalised label or a merged theme label of a current Meta or Watching subject is **not a Trend**: it is already tokenized and the Meta page owns it.

### 5.5 The untokenized check (code)

For each Trend, when it is first shown and again every 60 minutes while it is live (24 hours after it was last flagged):

1. **DexScreener.** Search each phrase (the raw key until the naming run has phrases) with `DexScreenerClient.search`. Keep Solana pairs whose name or ticker matches (every word of a phrase in the normalised name, or the ticker equals the phrase squashed together) and whose pair was created at or after the Trend's `first_seen` minus 48 hours **(proposal)**. A pair with no creation time is kept, not dropped (fail closed: dropping it could read a live coin as absent).
2. **The ticket 16 test.** Each kept pair goes through `isLiveToken` from `packages/core/src/meme/live-token.ts` (priced, liquidity at least $5,000, market cap at most 100 times liquidity). The check imports it; it does not copy it. A pair that fails is a lookalike, listed with its reason ("pool $4, cap $131K: drained or fake"), not counted.
3. **State.** `taken` if a live token has a market cap of $50,000 or more; `contested` if live tokens are all smaller; otherwise coin-side `open`.
4. **Local creates.** Count the distinct creators of stored pump.fun creates of the last 48 hours whose normalised name or ticker matches a phrase (one in-memory index built once per tick from the stored creates; no RegExp from the text). 0 to 4 distinct creators is "few or none"; 5 to 9 is `tokenizing` (the market is already moving on it; shown folded); 10 or more distinct creators in 24 hours is the Watching rule's own number, so the subject is dropped as above once the Meta pipeline lists it.
5. **Precedence, first match wins:** `not traced`, `taken`, `contested`, `tokenizing`, `untokenized`. A live token always outranks the local count (so a live $20K token with 6 local creators is `contested`, not `tokenizing`). **Untokenized** is coin-side `open` and local creators 4 or fewer. The numbers are shown (how many creates, how many creators), so the Operator can judge. Because PumpPortal misses about 47 percent of creates, a local count of 0 is weaker than it looks; the page says "local creates are a partial view".

A failed or missing DexScreener answer is `not traced` and keeps the last good trace. The state change times are stored: the lead-time measure reads them.

## 6. How it reaches the Operator

### 6.1 The War Room page

A new page `/radar` (text only, like `/moments`): live Trends by score, each with the plain subject (or the raw key until named), why now (which sources, since when, the numbers: traffic, countries, feeds, and from stage B the X count and its doubling), the coin-side state with the biggest live clone and the lookalikes, the local-creates line, flags, age, and "Watched" or "has ideas" badges. A strip on `/` says how many are shown and links in. A source-status block shows each source's state and last good poll, the model's runs today against its cap, and from stage B the X API's dollars today against its cap.

The War Room writes only **request or mark rows by an explicit POST the Operator causes, never as a side effect of a GET**; the worker applies each one (CODING_STANDARDS rule 1, as for the moment scanner):

1. **Watch on X** (ticket 06): a request row; the worker creates a Watched topic from the Trend.
2. **Make ideas** (ticket 07): a request row; the worker runs the `meme-ideas` path.
3. **Ignore**, **Keep** ("worth it", for the scorecard) and **Seen** (ticket 05): mark rows.
4. **Missed** (ticket 05): a small form to record a good subject the radar did not have, with where he found it.

### 6.2 Hand-off to the moment scanner (a topic inside its cap of 4)

The moment scanner owns its topics table and its cap: at most 4 active Watched topics, Metas first, then the Operator's by oldest scan, Watching subjects off (moment spec section 4). The radar does not build a second scanner and does not raise the cap.

- **Stage A, by hand.** "Watch on X" adds a topic whose label and spellings come from the Trend's key and phrases, passed through the moment scanner's one cleaner (ticket 05 there), start time the Trend's `first_seen` minus 12 hours **(proposal)**, expiry 7 days like an Operator topic. It counts as an Operator topic. When all 4 slots are taken the request ends `refused` with "4 topics are active" and the Trend shows it; nothing is queued or displaced.
- **Stage B, automatic (ticket 13, off by default).** The best Trend of each hour that is `untokenized` or `contested`, score 60 or more, flags free of `nsfw` and `political`, becomes a topic of source `trend`. These topics may hold **at most 2 of the 4 slots**, never displace a Meta or an Operator topic, live 12 hours (proposal, shorter than the research's 24 hours because two slots cannot hold hourly arrivals for longer) unless the Operator keeps them, and are released early after 3 empty scans (the radar's own release rule, not the scanner's slow-down rule of 6, which a 12-hour life could not reach in week 1).
  - **Cadence in numbers.** The scanner's loads stay under its own caps (ADR 0009 amendment: 100 a day in week 1, up to 300 after a week with no wall, shared with the Study's own separate cap). A topic scan is about 2 to 3 loads, so **week 1 allows about 33 to 50 scans a day across all topics, about one scan per topic every 3 hours with 4 topics** (and more often for a topic if fewer are active); week 2 on, at 300 loads, about one scan per topic every hour. So in week 1 a 12-hour topic gets about 4 scans, and 3 empty scans take about 9 hours: the release rule can fire inside the slot's life. At the hourly pace it fires after about 3 hours.
  - **How many automatic topics a day.** Two slots at a 12-hour life is 4 a day if every topic runs its life; early release can free a slot sooner, so the cap is **6 new automatic topics a day**. Expect 4 and at most 6; neither exceeds what the scanner's load cap can scan.
- Moments found under such a topic appear on `/moments` as for any topic, with their own coin-side trace. The radar adds nothing there.

### 6.3 Meme ideas

"Make ideas" on a Trend uses the existing path unchanged in its safety and caps: a request row, the worker runs `meme-ideas` with the Trend block (plain subject, phrases, sources and numbers, flags) as fenced untrusted data, names to avoid are the traced clones and lookalikes, and three ordinary `meme` Proposals are filed: 12-hour life, Shortlist or Dismiss, no Spec, no Build, no score (ADR 0013). Source marker: snapshot version 5, `kind: "trend"`, `meta_key = trend:<id>`, trigger `trend-operator`. It counts in the angle allowance (10 in any rolling 24 hours) and the research budget, not in the automatic 8-a-day cap. One request for the same Trend is allowed in 24 hours. **No automatic ideas from a Trend**: that waits, like the moment scanner's ticket 11, until the Operator has read the scorecard.

**Is a Trend a new Proposal source?** Recommended, in ADR 0016: yes, as a `meme` Proposal with a trend source (a fifth beside a Meta, a news story, an Operator angle and a Moment), pressed by the Operator, never automatic, and **not** a new `kind`. Reasons: every behaviour the idea needs already hangs off `kind = 'meme'`; the repo extends `meme` by source, as ADR 0013's Moment amendment did; and automatic ideas from third-party-fed trends would spend runs on noise before precision is known.

## 7. Cadence and caps

All caps are in code, in `packages/core/src/radar/config.ts`. Configuration may lower a cap and never raise it; raising is a reviewed code change (architecture invariant 3). Every spending path has a dry run.

| What | Cadence | Cap (proposal) |
|---|---|---|
| Google Trends, each country | every 15 min | 8 countries, 2 to 5 s apart |
| News feeds | every 15 min | about 30 feeds, conditional GET |
| Detect, score, skip, check | every 15 min tick | at most 30 DexScreener searches a tick |
| `radar-name` (haiku) | one batch every 30 min if there are new candidates, at most 15 candidates a batch | **48 runs a day in stage A**, hard ceiling 96 (stage B); its own Est. usage cap of $0.60 a day (ceiling $1.00); it counts in the research budget like the other tasks and is skipped when the rolling-24 h research budget is over 80 percent used, so it never starves judge and propose |
| Operator's "Make ideas" | on press | the angle allowance (10 a day), research budget; sonnet |
| X Trends (stage B) | every 30 min, 3 places | 144 requests a day |
| X Counts (stage B) | per fresh candidate | 200 requests a day |
| **X API spend (stage B)** | checked before every request | **$3.00 a day rolling 24 hours (about $2.44 is the planned use), $90 over 30 days**, a request whose price would pass either cap is not sent; a request with unknown cost (timeout, cut connection, 5xx) is charged at its price; an unreadable ledger counts as spent (fail closed) |
| Tripwire | continuous | the radar pauses its model runs and shows a banner when rolling-24 h Est. usage across all tasks passes $3 (the research's stop rule; normal use is $0.4 to $1.0), or on any X wall or challenge reported by the moment scanner's stop state |

**Brain use by tier**, the radar's own addition on top of today's $0.4 to $1.0 a day (measures: haiku $0.0022 to $0.0032 a run, sonnet ideas $0.0429 a run):

| | Stage A | Stage B |
|---|---|---|
| haiku runs a day (radar-name) | up to 48 | up to 96 |
| sonnet runs a day started by the radar | 0 | 0 |
| sonnet runs the Operator starts by pressing "Make ideas" (inside the 10-a-day allowance; the research assumed about 5) | about 5, $0.22 a day | about 5, $0.22 a day |
| Est. usage, the radar's own (haiku at about $0.003 to $0.004 a run, plus the presses) | about $0.4 a day at most, $12 a month (API-equivalent, on the subscription) | about $0.6 a day, $18 a month |

The research's stage B figure of about 125 runs, $1.1 a day and $33 a month **also counts the moment judge's 24 sonnet runs a day** (about $0.5 a day). Those runs belong to the moment scanner's own cap (its ticket 03) and are not the radar's: the radar only gives the scanner topics. They are shown here so the total is honest: radar plus the judge on handed-off topics is about $1.1 a day.

**Cash.** Stage A: $0. Stage B: about $75 a month ($43 Trends + $30 Counts), inside the $100 a month of real cash the architecture names. **X loads** on the logged-in account added by the radar: 0 in both stages. **Helius** credits: 0. **Machine:** a few HTTP requests a minute. **Operator time:** about 10 minutes a day in A, 15 in B.

## 8. The 14-day scorecard and the bar for A to B

The scorecard is a block on `/radar` computed from the live tables (ticket 05), so the verdict is read off the page and not argued from memory. Targets are proposals set before the data exists; with a small n the page shows the count beside every percentage.

| # | Measure | Target |
|---|---|---|
| 1 | **Lead time.** For every Trend that gets a live clone with liquidity of $10K or more and a market cap of $20K or more within 24 hours of its first flag: minutes from the radar's first flag to that clone's creation, and against the time the Operator noticed it (his "Seen" mark, or his "Missed" entry) | radar earlier on at least 60 percent, median at least 60 minutes |
| 2 | **First source.** The first source per good Trend. A source that is never first in 14 days is dropped | none left unused |
| 3 | **Precision and noise.** Trends shown a day; share the Operator presses Watch, Make ideas or Keep on; false flags a day (Ignored or judged not concrete) | at least 5 shown a day, at least 30 percent kept, at most 10 false flags a day |
| 4 | **The untokenized check.** The page lists 20 random `untokenized` Trends with a DexScreener link each; the Operator looks for a live clone by hand and marks it. Also the `taken` ones read as live that were drained pools, and the count of `not traced` | at most 2 wrong of 20 |
| 5 | **Blind spots.** Each good subject the radar did not have before its coin, entered as "Missed" with where he found it (X clip, X post, news, other); and 10 "no coin yet" calls a day by a human caller where he wants to compare (PetalSoI posts about 17 a day, `x-account.md`) | reported, no target |
| 6 | **Cost.** Per day: model runs by tier, Est. usage, X API dollars against the cap (stage B), any wall or stop, the Operator's minutes (he types a number once a day) | no wall; Est. usage under $3 |
| 7 | **Go or stop.** The Operator picks | see below |

**The bar for going from A to B** (read on day 14 of stage A, by the Operator, with the page open):

- **A must first be worth keeping.** Measure 3 and measure 4 pass: at least 5 shown a day, at least 30 percent kept, at most 10 false flags, at most 2 wrong of 20. If A fails this, stop, or fix the sources; B on top of noise only adds a bill.
- **And A's gap must be X-shaped.** Of the good subjects the radar did not have before their coin (measure 5, at least 5 of them), at least half were first seen on X (a clip, a post). Then X's trend counts plausibly add something; if most misses were news A should have caught, B adds nothing and the answer is more feeds, not the X API.
- **Then, and only then, he writes "go B" and prepays.** Ticket 09 is his checklist. He should prepay a small amount first (for example enough for a week at the planned use), run the audit command of ticket 12 over the week's misses, and keep paying only if it shows a rise on X before the coin on a majority of them.
- If B runs and its 14 days show the X API was first on too few good Trends (measure 2) or the dollars passed the cap, drop to A. Ticket 14 computes this line (proposal: X first on at least 20 percent of good Trends or the only source on at least 2, no day over the cap and no wall, under $15 per good Trend with X first). Option C (topic-free browser scanning) is not opened by this spec: it needs its own decision and a second ADR 0009 amendment.

## 9. What stays manual

- **Launching.** The Operator launches. Argus never launches, signs or holds a key (ADR 0002). A Trend, an idea and an image idea are text.
- **Opening an X developer account, prepaying, naming the key, and saying "go B"** (ticket 09). No agent can or should do these.
- **Pressing** Watch on X, Make ideas, Ignore, Keep, and entering a Missed subject. Nothing is automatic past the page in stage A, and in stage B only the Watched topics of ticket 13 are, under the caps in 6.2.
- **Reading the clip, the post, the coin.** The model reads text and counts. Whether a subject is worth a coin is his call.
- **The 20-sample of `untokenized` Trends** (measure 4) and the day-14 verdict.
- **Re-logging in to X after a wall** and any use of the Argus Chrome profile by hand, as for the moment scanner.
- **Not in this spec:** Telegram messages for a new Trend (the Operator deferred nudges for the scanner until he has read 14 days of data; the same applies here), automatic ideas, topic-free browser scanning, a second X account, video or image understanding, anything that posts, likes, follows or messages (invariant 6).

## 10. Decision records

- **ADR 0016** (new): a Trend is its own thing and not a Source, a Signal or a Narrative; a Trend idea is a `meme` Proposal with a trend source and no new kind; stage B pays for X's official API under a spend cap in code, behind one module and one host, with a hand-off to the moment scanner under a slot limit. It is recommended and written with this spec; the Operator's choice of Option B is its basis. A short pointer is added to ADR 0013.
- **ADR 0009 gets a dated one-line pointer amendment** (added with this spec): a Trend-sourced Watched topic (tickets 06 and 13) is a third origin of topic text, after a Meta and the Operator, built from cleaned third-party text under the same limits (the scanner's one cleaner, the fixed operator list, the same caps). It changes no page, cap or rule. The radar otherwise uses the browser only through the scanner's topics. The ADR notes the official API "remains the compliant path"; ADR 0016 is the first use of it, for subject-level counts only. The Study's capture stays on the browser (its API cost was $330 to $630 a month).
- **No ADR 0011 or 0002 amendment.** The radar is not a Source; it reads public APIs, never a chain, never a wallet. `adr-0002.test.ts` bans swap and RPC hosts, not the X API host; ticket 10 adds its own tripwire test pinning the one module that names the X host.

## 11. Risks and what we do not know

- **Stage A may find little.** The research expects 0 of the 11-19 winners from A. Hence the replay (ticket 03) before the live run, and the day-14 bar.
- **Noise.** Google Trends is mostly sport, celebrity and weather; a fed-in term can be a person (the legitimacy flags apply and the Rubric v3 wording is reused downstream). The 40-point floor and 30-row cap are the first defence.
- **The check can be wrong.** A DexScreener search shows its first page only, so a tiny coin can be missed (inferred); PumpPortal misses about 47 percent of creates. Measure 4 exists for this.
- **X's own trend list can be gamed or political** (inferred); `political` and `nsfw` flags block automatic hand-off.
- **Two slots for automatic topics** slow each topic's scan (about hourly) and may starve a Meta's clips of loads; the cap rule above keeps Metas first.
- **Cost of the API is a research reading**, not a quote: the pricing page lists pay-per-use with no spending limit, whether a Counts response is billed twice when re-read is not stated, and Counts granularity (hourly buckets) is from memory of the API (inferred). Ticket 10 verifies before writing code.
- **Whether `claude -p` keeps drawing from the subscription** is unresolved (architecture section 13). If a separate $100 monthly pool applied to headless runs, today's $21 plus stage A ($12) fits and stage B ($33) still fits.
- **Not checked here:** I opened no X page, no live trend page and no DexScreener endpoint; every figure is the research's or the repo's.

## 12. Slices

Each ticket is one thin vertical slice. Stage A first. Ticket 01 is useful alone: the Operator opens `/radar` and sees Google Trends' rising terms, each with the untokenized check, from one switch, with no model and no X.

| # | Title | Stage | Model | Blocked by |
|---|---|---|---|---|
| 01 | Google Trends rising terms and the untokenized check on a War Room Radar page | A | sonnet / high | none |
| 02 | More countries, a radar-only news feed list, and the agreement score | A | sonnet / medium | 01 |
| 03 | Replay on the stored database: when did each known subject first show up | A | sonnet / medium | 02 |
| 04 | The naming and filter run (`radar-name`, haiku) | A | sonnet / high | 01 |
| 05 | Marks, the Missed form and the 14-day scorecard | A | sonnet / medium | 01, 02 |
| 06 | "Watch on X": a Trend becomes a Watched topic | A | sonnet / high | 01 (and moment-scanner 05, 08) |
| 07 | "Make ideas" from a Trend through the meme-ideas path | A | sonnet / high | 04 |
| 08 | Architecture doc and pipeline graph lines for the radar | A | haiku / low | 07 |
| 09 | Operator step: open an X developer account, prepay, hand over the key | B | Operator | 05 (and the Operator's "go B") |
| 10 | The X API client: one host, a spend ledger, caps in code, a dry run, the spend block on the page | B | sonnet / high | 01, 09 |
| 11 | X Trends for three places | B | sonnet / high | 02, 10 |
| 12 | X Counts per candidate for velocity, and the audit command | B | sonnet / high | 04, 11 |
| 13 | Automatic Watched topics from the best Trends | B | sonnet / high | 06, 12 (and moment-scanner 05, 08) |
| 14 | The stage B go-or-stop block on the scorecard | B | sonnet / medium | 05, 12 |

Order of value in stage A: 01 alone is useful; 02 and 03 say whether more sources help; 04 makes the list readable and the check precise; 05 makes the 14 days measurable; 06 and 07 are the doors out. Tickets 06 and the automatic part of 13 need the moment scanner's topics table and load caps (its tickets 05 and 08, ready-for-agent, not built); they say so in their own text, and until then the radar is a page.

## 13. Open questions for the Operator

When each is asked:

1. **The first 8 countries and the 30 feeds** (stage A). The agent proposes the feed list in ticket 02 and **shows it to the Operator in that ticket's Comments before it goes live**: any you want in or out?
2. **The X token allowlist** (stage B): is `X_API_BEARER_TOKEN` an acceptable name to add to the dev server's allowed list (it today takes `ARGUS_*` and `HELIUS_API_KEY` only)? Asked **before stage B**, in ticket 09 step 7, and again by ticket 10 if a different name is chosen.
3. **The caps** (stage B): is a $3 daily and $90 30-day X API cap right, and is the prepay-small-first plan (section 8) what you want? Asked **before stage B**, in ticket 09 step 2.
4. **Automatic topics** (stage B): 2 of the 4 slots, 12 hours each, release after 3 empty scans, or should the radar never take a slot without your press? Asked **before stage B**, in ticket 09 step 2 (and before ticket 13 is built).

Questions 2 to 4 are not asked now: they have no meaning until stage A has run its 14 days and the Operator has written "go B".
