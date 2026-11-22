# 12: X Counts per candidate for velocity, and the audit command
**Model:** sonnet / high. Real dollars per candidate, and third-party phrases become a query on a paid API. The care is the per-day request cap, the dollar gate and that a query can never carry an operator from text.

**What to build:** for each fresh candidate that passed the score floor (named, `untokenized`, `contested` or `not traced`, first 24 hours, not ignored), one Counts request for its cleaned phrases, hourly buckets over the last 24 hours. Plain code reads the curve: did the last 3 hours at least double the 3 before, with at least 200 posts in the last hour. A rise adds 20 points and shows a small count curve on the row. A second command, `pnpm radar:audit`, takes a list of past subjects and times and reports whether X's counts rose before each one's coin, for a few cents: the Operator's check, in the first week, of whether stage B is worth paying for. Useful alone: the radar can say "this phrase passed 1,000 posts an hour ago and doubled since" for half a cent, with no page load.

Status: wontfix

**Blocked by:** 04, 11
Spec: sections 4.2, 5.2, 7 and 8. ADR 0016 decision 3.

## Design

- **Query builder** (`radar/x-query.ts`): `("<phrase>" OR "<phrase>") -is:retweet` (straight ASCII double quotes), built by code. The words come from the Trend's cleaned phrases (letters, digits and spaces, 1 to 4 words each, at most 4 phrases, the model's limits), inside double quotes; the operators are literals from a fixed list (`OR`, `-is:retweet`, optionally `lang:en`). A phrase can never add an operator, a `from:`, a negation or a quote; a phrase that cleans to empty is dropped; no phrase left means no request. A query longer than the documented maximum is cut by phrase, never mid-word.
- **When.** Only for a Trend that is shown, named (ticket 04), not `taken` or `tokenizing`, not asked in the last 60 minutes, and in its first 24 hours; at most **200 requests a day** (the cap lives in ticket 10's gate and is **shared with `pnpm radar:audit`**, so an audit run uses up that day's Counts room and the job sees `capped`) and at most 10 a tick; through ticket 10's gate every time. A `capped` or stopped client skips; a Trend with no answer has **no X velocity**, never "flat".
- **Curve.** Hourly buckets over 24 hours, stored with the reading. Rise = the sum of the last 3 full hours at least twice the 3 before and at least 200 posts in the last full hour (**proposal**, tuned on the data like every number). Points +20 (spec 5.2); the page shows the curve as numbers and a tiny text bar, no chart library.
- **Billing questions** settled in ticket 10's findings: if a re-read is billed again, a candidate is asked at most once an hour and the ledger counts it each time; the daily request cap is the real limit.
- **`pnpm radar:audit`** (`scripts/radar-audit.mjs`): takes a small JSON file of `{ phrases, cloneCreatedAt }` (past subjects and when their coin was made, the "Missed" entries of ticket 05 can be exported for it), asks Counts for the 24 hours before `cloneCreatedAt` (the recent endpoint reaches back about 7 days, so only subjects within that window work; older ones are reported "out of range", not guessed), and prints per subject whether the rise rule held, how many hours before the coin, and the dollars. It goes through the same gate and ledger, supports `--dry-run`, refuses more than 40 subjects in one run, and prints the total dollars first.
- **Model tier.** The radar's own haiku runs stay at their default of 48 a day; if the first days of stage B show the cap binding, raising the default toward the ceiling of 96 is a reviewed code change made in this ticket's Comments with the numbers, never by configuration.

## Acceptance criteria

- [ ] **Query builder** (`x-query.test.ts`): hostile phrases (`GTA VI from:someone`, `"a" OR (b)`, `-filter:links`, `min_faves:0`, 10,000 characters, control characters, emoji, a phrase that is only an operator) produce a query with only the literals above and quoted words; an empty set yields no request; the length cut never splits a word; no RegExp from any phrase.
- [ ] **Velocity** (`velocity.test.ts`): 100, 120, 130 then 400, 500, 600 posts an hour is a rise; a steady 1,000 an hour is not; a rise with 150 posts in the last hour is not; a missing bucket or an empty answer is "no velocity", never zero or flat; the +20 is added once.
- [ ] **Job and spend** (`x-counts-job.test.ts`, fake clock, real ledger): 200 requests a day and 10 a tick are never exceeded; a Trend asked 20 minutes ago is not asked again; a `taken` or ignored Trend is not asked; with the day at $2.99 or a stopped client nothing is sent and the page says why; a dry run sends nothing.
- [ ] **Audit** (`radar-audit.test.ts`, fake client): a fixture subject with a doubling curve 3 hours before its coin reports a rise 3 hours before; a flat one reports none; a subject 10 days old is "out of range" with no request; 41 subjects are refused; the total dollars print first and a dry run costs nothing; the gate caps it like any other request, and it counts against the 200-a-day Counts cap shared with the job (an audit of 30 subjects leaves the job 170 that day; at the cap the audit stops with "request cap" and reports what it finished).
- [ ] **Page** (`radar-render.test.ts`, `pnpm page:check --seed /radar`, seeded): the count curve, "no velocity" and the +20 in the score breakdown; no overflow at 390 or 1240 px.
- [ ] **Real run, once** (not a test, the Operator's key and prepaid balance): `pnpm radar:audit` over the week's Missed subjects within range (at most 20); paste the report, the dollars and the share that rose before the coin into Comments. This is the evidence the Operator uses to decide whether to prepay more (ticket 09, step 9).
- [ ] Type-check, `pnpm lint` and the full `pnpm check` pass, run once before the commit.

## Constraints

- Follow `docs/agents/worker-rules.md`. Every request goes through ticket 10's gate. No tests hit the real API.
- Commit subject `Trend radar ticket 12: X Counts for velocity and the audit command`, body ends with `Ticket: .scratch/trend-radar/issues/12-x-counts-velocity-and-audit.md`. No `Closes #N`.

## Comments
- 2026-11-21 cos triage: no paid X; X is read through the logged-in Argus Chrome profile (Operator, 2026-11-21)
