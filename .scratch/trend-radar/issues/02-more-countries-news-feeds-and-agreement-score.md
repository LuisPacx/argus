# 02: More countries, a radar-only news feed list, and the agreement score
**Model:** sonnet / medium. Plain counting on data ticket 01 already stores, plus a second reader that uses the same cleaner and parser. No model, no new trust boundary; if the agent finds it must change ticket 01's cleaner, stop and raise it.

**What to build:** the radar stops being one feed and becomes a counter of agreement. Google Trends is polled for about 8 countries; about 30 news feeds in a radar-only list are polled; headline phrases that three or more distinct feeds carry within 3 hours become candidates; and the **score** (spec 5.2) decides what the page shows. Useful alone: the Operator sees a subject because several independent places carry it, which is the cheapest lead the research found (Anthropic IPO on 13 feeds, about 9 hours before the first matching coin), and the Google noise of one country no longer fills the page.

**Status:** ready-for-agent

**Blocked by:** 01
Spec: sections 4.1, 5.1 to 5.3.

## Evidence and design (read before building)

- The feed list is a new file `config/radar-feeds.json` in the shape of `config/rss-feeds.json` (`id` `radar:<slug>`, `label`, `url`). **Do not add feeds to `config/rss-feeds.json`**: that adds Signals and changes Narrative clustering (spec 4.1, ADR 0016 decision 1). About 30 feeds in four groups: entertainment (film, TV, music news), gaming, sport, and "upcoming" (release calendars, trailer and event news). The agent verifies each URL loads, parses and allows reading (a robots or terms check) and lists the rejected ones in Comments. **Show the Operator the final list in Comments before the switch is on** (spec open question 1).
- Reuse `parseRssItems`, `timedFetchText` (2 MB cap, 10 s timeout) and `stopwords.ts`. Conditional GET (ETag or Last-Modified) where the feed supports it; a 304 is a good poll with no new items.
- Headline phrases are counted by code: word sequences of 1 to 4 words with stop words dropped, lower-cased through `normalizeKey`; a phrase counts once per feed. A phrase becomes a candidate when 3 or more distinct feeds carry it within 3 hours and its key is not in the seen-set. The model never extracts terms from headlines.
- **Score** (spec 5.2): 20 points per independent source within 3 hours up to 4 (Google in any country is one source, each feed is one), +10 for Google `approx_traffic` of 5,000 or more or +20 for 20,000 or more, +10 for 3 or more Google countries. Shown from 40 points, at most 30 rows, at most 10 new an hour; a Trend is flagged again only when its score crosses 70 or its state changes ("changed" with the time). All numbers in `radar/config.ts`. The `upcoming date` (+10) and the stage B points arrive with tickets 04 and 12; leave the slot in the table.
- Countries: `googleGeos` becomes data (proposal: US, GB, CA, AU, IN, BR, DE, JP); one request per country per 15 minutes, 2 to 5 seconds apart, jittered, per-country backoff.

## Build

1. `radar/readers/rss.ts` over `config/radar-feeds.json` with per-feed status (`ok`, `backing off`, `format changed`, `down` after 3 failures in a row, then retried hourly) and the conditional GET.
2. `radar/phrases.ts`: the headline phrase counter and its 3-hour window; store each phrase reading with its feed in `radar_readings`.
3. `radar/score.ts`: `scoreTrend(readings, now)` returning the points with a breakdown (the page shows why); thresholds from config.
4. Job: merge the sources into one candidate stream; the shown rule of ticket 01 becomes the score; the check of ticket 01 runs on shown Trends only. The page shows "why now": which sources, since when, the numbers, and a score breakdown on open.
5. Source-status block lists every country and feed with state and last good poll; a feed `down` does not block another.

## Acceptance criteria

- [ ] **Feed list** (`radar-feeds.test.ts`): every entry has a unique `radar:` id and an https URL; `config/rss-feeds.json` is byte-identical to its state before this ticket (the test fails if a radar feed id appears there); the Narrative sources registered by the worker are unchanged (`source-polls.test.ts` still passes).
- [ ] **RSS reader** (`readers/rss.test.ts`, recorded feeds, fake fetch): items parse; a 304 is a good poll; a 429 backs off per feed; three failures mark the feed `down` and it is retried hourly; a non-feed body is `format changed`; one feed failing leaves the others polled.
- [ ] **Phrase counting** (`phrases.test.ts`): a phrase in 3 distinct feeds inside 3 hours is a candidate; the same phrase 5 times in one feed, or in 3 feeds spread over 5 hours, is not; stop-word-only phrases are not; "GTA VI" in one feed and "GTA 6" in another are one key; 20,000 characters of headline do not make the counter slow (a bounded-time test); no RegExp from the text.
- [ ] **Score** (`score.test.ts`): 3 feeds is 60; Google alone at 2,000 traffic is 20 and not shown; Google in 3 countries at 25,000 plus one feed is 20 + 20 + 20 + 10 = 70; a fifth source adds nothing; 39 is hidden and 40 shown; the replayed Anthropic IPO fixture (13 feeds) is shown; a Trend crossing 70 is "changed" once, not on every tick.
- [ ] **Job** (`job.test.ts`): sources merge into one row per key; the 30-row and 10-an-hour limits hold; a Meta's label from a fixture is skipped as in ticket 01; a country in `backing off` does not stop the others and is not counted as a quiet hour.
- [ ] **Render** (`radar-render.test.ts`, `pnpm page:check --seed /radar`, seeded): "why now" and the breakdown show for a multi-source Trend; every country and feed shows with its state; no overflow at 390 or 1240 px; hostile headline text renders as one escaped line.
- [ ] Type-check, `pnpm lint` and the full `pnpm check` pass, run once before the commit.

## Constraints

- Follow `docs/agents/worker-rules.md`. Nothing here writes `signals`. Every new request has its cap and jitter in `radar/config.ts`.
- Commit subject `Trend radar ticket 02: more countries, radar-only news feeds and the agreement score`, body ends with `Ticket: .scratch/trend-radar/issues/02-more-countries-news-feeds-and-agreement-score.md`. No `Closes #N`.

## Comments
