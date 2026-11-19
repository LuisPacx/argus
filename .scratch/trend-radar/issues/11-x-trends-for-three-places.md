# 11: X Trends for three places
**Model:** sonnet / high. The first ticket that spends real money. It touches the spend cap, the key and third-party trend names that become candidates.

**What to build:** every 30 minutes the worker asks X's Trends endpoint for three places (worldwide, US, UK) through ticket 10's client, turns each `trend_name` into a candidate beside the Google and news candidates, and lets it score: an X trend is one more independent source, with its `tweet_count` shown. Subjects X promotes that no feed carried appear on `/radar`, with the same untokenized check and naming run as any other. Useful alone: the page gains X's own view of what is rising, at about $1.44 a day, with the day's dollars on the page.

**Status:** blocked (waits for tickets 02 and 10, and through 10 for the Operator's step, ticket 09)

**Blocked by:** 02, 10
Spec: sections 4.2, 5.2 and 7. ADR 0016 decision 3.

## Design

- **Reader** `radar/readers/x-trends.ts`: places from config (`worldwide`, `US`, `UK` as their numeric ids from ticket 10's findings), one request each every 30 minutes through `getTrends`, jittered by a few seconds; 144 requests a day at most, a cap that lives in ticket 10's gate and not in this job. `trend_name` goes through `cleanTerm` and `radarKey` (a trend name is third-party text and can be a hashtag, a foreign-script phrase or something hostile); `tweet_count` is stored with the reading, **missing when X omits it (under 1,000), never zero**. Source id `radar:x-trends:<place>`; the three places count as **one** independent source in the score.
- **Spend.** Each tick asks the gate first; a `capped` answer skips the place and the page says so; a stopped client (401, 402, 403) skips everything and says why. The tick never retries inside itself.
- **Score.** X Trends carrying the key counts as one source (20 points, inside the 4-source maximum). The `tweet_count` is shown; the doubling points (+20) arrive with ticket 12. The `tweet_count` has no threshold in this ticket: do not invent a bar before the data.
- **A trend list is not a Trend list.** Most of X's trends are already huge, already tokenized or not nameable (a sports score); they go through the same skip rule (Meta, Watching), score floor (40 points: so an X trend alone, at 20 points, is shown only with a second source) and naming run as every other candidate. Say so in the ticket's Comments after the first day, with how many of the 144 reads made a shown Trend.
- **Switch.** `ARGUS_RADAR_X_API=1` (off by default; ticket 10). Dry run logs the requests.

## Acceptance criteria

- [ ] **Reader** (`readers/x-trends.test.ts`, recorded response fixtures, fake client): trends parse into candidates with keys; a trend under 1,000 posts has no count (not 0); a hostile `trend_name` (markup, `from:x`, 100,000 characters) is cleaned and cut; three places give one source in the score; a place that fails does not stop the others.
- [ ] **Spend** (`x-trends-job.test.ts`, fake clock, real ledger on a temp dir): 144 requests fit in a day; with the day's spend already at $2.99 the next tick sends nothing and says "daily cap"; a stopped client sends nothing and says why; no tick sends a second request to the same place within 30 minutes; a dry run sends nothing and records nothing.
- [ ] **Score and shown** (`score.test.ts`): a key carried by an X trend and one feed is 40 and shown; an X trend alone is 20 and not shown; the same key from three places is one source.
- [ ] **Page** (`radar-render.test.ts`, `pnpm page:check --seed /radar`, seeded): the X count beside the sources of a Trend, "no count" for a trend under 1,000, the X API block with today's dollars; no overflow at 390 or 1240 px.
- [ ] **Real run, once** (not a test, the Operator's key and prepaid balance, a short window): two ticks live; paste the ledger rows (endpoint, price, status), the dollars against the cap, the number of trends read and how many became shown Trends into Comments. A refused or stopped client is a valid result: record the status.
- [ ] Type-check, `pnpm lint` and the full `pnpm check` pass, run once before the commit.

## Constraints

- Follow `docs/agents/worker-rules.md`. Every request goes through ticket 10's gate; no second client. The radar writes no Signals from X data (the architecture's "No X as a Source" line stands).
- Commit subject `Trend radar ticket 11: X Trends for three places`, body ends with `Ticket: .scratch/trend-radar/issues/11-x-trends-for-three-places.md`. No `Closes #N`.

## Comments
