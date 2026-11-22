# 05: Topics from current Metas and from the Operator
**Model:** sonnet / high. Text that can come from token creators (a Meta's label) or the Operator ends up inside a search query on the logged-in X account. The care is that it can never add an operator or widen the search.

**What to build:** replace ticket 01's single `ARGUS_MOMENT_TOPIC` with a table of Watched topics. Every current Meta becomes a topic automatically; the Operator adds his own on the Moments page. The scanner takes turns across active topics. This is what makes the scanner general (any topic) and what lets it watch a subject that has no Meta yet. Useful alone: the Operator can point the scanner at a new subject in one form, without a deploy.

Status: wontfix

**Blocked by:** 02, 08
The turn-taking below relies on ticket 08's hourly cap, ramp and session wrapper, so topics are never scanned faster than the account's caps allow. Decided by the Operator (2026-11-19): at most 4 active topics, Watching subjects off, a Meta topic starts at the Meta's entry minus 24 hours, a manual topic takes a start time the Operator sets.

## Design

- **Table** `moment_topics` (id, label, spellings JSON, `starts_at`, `source` `meta|operator`, `meta_key` nullable, `created_at`, `expires_at`, `active`, `last_scanned_at`). Idempotent create; the old env topic is read once at boot as an Operator topic if the table is empty, then ignored (note it in Comments).
- **From Metas:** each tick, for every current Meta (at most 3; Watching off by default, `ARGUS_MOMENT_WATCHING=1` turns it on), upsert a topic keyed by the Meta's key: label from `CurrentMeta.label`, spellings from the label and its merged theme labels (`themes`, at most 12), plus plain variants: a roman numeral and its digit (VI and 6, I to XX), the spaceless form, the hashtag form; at most 6 spellings, shortest first after the label. `starts_at` is the Meta's `enteredAt` minus 24 hours. A topic stays active 24 hours after its Meta leaves.
- **From the Operator:** `POST /api/moment-topics` `{ label, spellings (0 to 6), startsAt }` (the start time is required: the Operator sets it, as the release time for GTA VI; a missing one is a 400); body-size and JSON handling as `meme-angle.post.ts`; the server cleans and validates (below), refuses a 5th active topic (cap of 4 active, `ARGUS_MOMENT_TOPICS_MAX` can only lower it, ceiling 6), and the same cleaned label twice. Expiry 7 days from creation or last renewal; a "Renew" and a "Stop" mark. The War Room writes the request row; the worker applies it (the War Room writes no scanner state).
- **Cleaning** (one function used for both sources): words limited to letters, digits, spaces and `#`, each spelling cut to 40 characters, a spelling that contains an X operator word (`from`, `to`, `filter`, `since`, `until`, `min_faves`, `min_retweets`, `lang`, `url`, `list`, `near`, `within_time`) followed by a colon is dropped, not repaired, quote and parenthesis characters removed. `startsAt` must be a valid date within the last 14 days and not in the future.
- **Turns:** the worker picks the due topic (Metas first, then the Operator's by oldest scan) subject to 01's caps; a topic with 6 scans in a row that flagged nothing is scanned at half the rate until something flags. Per-topic Moments and the page group by topic.

## Acceptance criteria

- [ ] **Cleaning** (`topic.test.ts`): hostile labels and spellings (`GTA VI from:elonmusk`, `x min_faves:0`, `"a" OR (b)`, `-filter:links`, 10,000 characters, control characters, emoji, a label that is only an operator) yield queries with only the literals from `query.ts`; an operator-colon spelling is dropped and the rest kept; an empty result refuses the topic; `startsAt` in the future, invalid, or 30 days old is refused.
- [ ] **Spellings** (`spellings.test.ts`): "GTA VI" gives GTA 6, GTA6, #GTA6 and #GTAVI; "Vice City" gives no numeral variant; "Super Bowl LX" is not rewritten (only I to XX standing alone as the last word is); the cap of 6 holds with the label always kept; a Meta with themes `Lucia`, `Vice City`, `GTA 6 Cat` adds each.
- [ ] **Meta topics** (`meta-topics.test.ts`, real `currentMetas` output from a fixture): a new Meta adds a topic with `starts_at = enteredAt - 24 h`; a Meta that leaves keeps it 24 hours and then it stops; Watching subjects are not topics unless switched on; a Meta label made of token-name text with an operator in it is cleaned, not rejected as a whole.
- [ ] **API** (`apps/warroom/server/test/moment-topics.test.ts`): a good body returns 200 and a pending row; wrong types, extra keys, an empty label, 7 spellings, a non-JSON or oversized body are 400 with nothing stored; the 5th active topic is 429 with the reason; a duplicate label is 409; the War Room process writes no scanner table other than the request row (checked on the DB); GET lists topics with their state and last scan time.
- [ ] **Worker** (`moments-job.test.ts`): Metas are scanned before Operator topics; with the load caps from 01 and 08 a topic is skipped, not cut mid-scan; an expired Operator topic stops and is not deleted; the env topic is imported once.
- [ ] **Page** (`moment-topics-render.test.ts`, `pnpm page:check --seed /moments`, seeded): the topic form with `maxlength` and the server's reason on a refusal, the topic list with source, start time, expiry, last scan and Renew and Stop; a hostile label renders as one escaped line; keyboard: `--keys "focus=[data-test=topic-summary],Enter,Escape" --watch "[data-test=topic-form]"` opens and closes the form (the script blocks the submit); no overflow at 390 or 1240 px.
- [ ] Type-check, `pnpm lint` and the full `pnpm check` pass, run once before the commit.

## Constraints

- A topic's text is never trusted and never reaches a query except through the cleaner and the literals. No RegExp built from it. The Operator's own text gets the same cleaning, on purpose: one path, one test.
- Commit subject `Moment scanner ticket 05: topics from Metas and from the Operator`, body ends with `Ticket: .scratch/moment-scanner/issues/05-topics-from-metas-and-operator.md`.

## Comments
- Superseded by .scratch/human-researcher (ADR 0017: agents run only on Operator trigger)
- 2026-11-21 cos triage: ADR 0009, the Operator researches; the automatic moment loop stays off (ARGUS_MOMENTS)
