# 06: "Watch on X": a Trend becomes a Watched topic
**Model:** sonnet / high. A button on third-party text ends up as a search query on the logged-in X account. The care is that it goes through the moment scanner's one cleaner and its caps and can never add an operator, widen the search or take a slot from a Meta.

**What to build:** on each Trend of `/radar`, a **Watch on X** button. It writes one request row; the worker turns the Trend into a Watched topic of the moment scanner (its topics table, label and spellings from the Trend's subject and phrases, cleaned by the scanner's cleaner, start time the Trend's first flag minus 12 hours, expiry 7 days like an Operator topic). The Trend then shows a "Watched" badge and a link to `/moments`; Moments found under it appear there with their own coin-side trace. Useful alone: the Operator goes from a subject the radar found to the scanner looking for its clips in one press, with no form to fill.

**Status:** superseded

**Blocked by:** 01
Radar tickets only on the line above; the two moment-scanner tickets are the external block. Spec: section 6.2 (stage A). ADR 0016 decision 4.

## Design

- **No new scanner, no new cap.** The moment scanner owns `moment_topics`, the cap of 4 active topics (Metas first, then the Operator's by oldest scan, Watching off), the cleaner, the load caps, the ramp and the shared stop state. This ticket adds one **source value**, `trend`, to the topics table (an idempotent change), a nullable `trend_id`, and one function in the radar that asks for a topic. A manual press counts as an Operator topic for ordering and for the cap (so it can be refused when 4 are active, never displacing a Meta or another Operator topic).
- **Request.** `POST /api/radar/watch` `{ trendId }` writes one `radar_requests` row (insert only; body handling as `meme-angle.post.ts`) and nothing else. The worker applies it: build `{ label, spellings, startsAt }` from the Trend's subject (the raw key if not named) and phrases, **through the scanner's cleaner (its ticket 05)**, never through a second cleaning path; a topic whose label cleans to empty is refused; the 5th active topic is `refused` with "4 topics are active"; the same cleaned label twice is `refused` as already watched; a Trend that is `tokenizing`, `taken` or ignored can still be watched (the Operator's call) but the button says what the state is.
- **Result.** The request ends `done`, `refused` or `failed` with a reason, never left waiting by a cap. The Trend's row shows the topic's state and last scan time read from the topics table.
- **Safety.** The text is third-party. A model-written phrase and a feed term reach X only as the scanner's cleaned spellings built from its literals. No operator word followed by a colon survives. Nothing here loads a page itself.

## Acceptance criteria

- [ ] **Request API** (`apps/warroom/server/test/radar-watch.test.ts`): a good body returns 200 and one pending row; wrong types, extra keys, an unknown Trend, a non-JSON or oversized body are 400 with nothing stored; a second press for the same Trend while one is waiting is 409; the War Room process writes no scanner table (checked on the DB); a GET leaves every table unchanged.
- [ ] **Worker** (`radar-watch-job.test.ts`, real topics table on a temp dir): a Trend with subject "GTA VI" and phrases "GTA 6", "gta6" becomes a topic with the label and the scanner's spelling variants, `source = trend`, `starts_at` = first flag minus 12 hours, expiry 7 days; a Trend whose raw key is `from:elonmusk x min_faves:0` becomes a topic with only the cleaned words (the scanner's own cleaning tests still pass unchanged); a label that cleans to empty is refused; a 5th active topic is refused with the reason and displaces nothing; a duplicate label is refused; a Meta's topic and an Operator's topic are untouched.
- [ ] **Scanner unchanged** (`moments-job.test.ts` still passes untouched): a `trend` topic is scanned under the same load caps, ramp, lock and stop state; with the stop state `stopped` no load happens for it.
- [ ] **Render** (`radar-render.test.ts`, `pnpm page:check --seed /radar`, seeded): the button, the "Watched" badge with the topic's state, the refusal reason; keyboard: `--keys "focus=[data-test=radar-watch]"` focuses the button without pressing it; no overflow at 390 or 1240 px.
- [ ] Type-check, `pnpm lint` and the full `pnpm check` pass, run once before the commit.

## Constraints

- Follow `docs/agents/worker-rules.md`. This ticket must not change the scanner's caps, the ramp, the stop rules or the allowed pages (ADR 0009 amendment). If the topics table or cleaner has a different shape than the moment ticket 05 describes, follow the merged code and say so in Comments.
- Commit subject `Trend radar ticket 06: Watch on X turns a Trend into a Watched topic`, body ends with `Ticket: .scratch/trend-radar/issues/06-watch-on-x-trend-becomes-a-watched-topic.md`. No `Closes #N`.

## Comments
- Superseded by .scratch/human-researcher (ADR 0017: agents run only on Operator trigger)
