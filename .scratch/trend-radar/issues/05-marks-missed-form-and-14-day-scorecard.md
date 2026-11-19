# 05: Marks, the Missed form and the 14-day scorecard
**Model:** sonnet / medium. Plain code over tables the radar already writes, plus insert-only request rows in the pattern of the moment scanner and the Operator angle. No model. The care is that the page writes only rows the Operator causes, and that the numbers say how small n is.

**What to build:** four small things on `/radar` and one block. **Ignore** (hide a Trend), **Keep** ("worth it", for the scorecard) and **Seen** (record that the Operator looked and when) as mark rows; a **Missed** form to record a good subject the radar did not have (the term, where he found it: X clip, X post, news, other, and a time if he knows it); a find box that searches the stored Trends and readings by text, read-only; and the **Scorecard** block that computes the spec's 14-day measures from the live tables. Useful alone: after 14 days the verdict on stage A is read off the page, not argued from memory, and it is the gate for stage B (ticket 09).

**Status:** ready-for-agent

**Blocked by:** 01, 02
It needs the score and first-source data of ticket 02. Spec: sections 6.1 and 8.

## Design

- **Writes.** `POST /api/radar/mark` `{ trendId, kind: "ignore"|"keep"|"seen" }` and `POST /api/radar/missed` `{ term, foundOn: "x-clip"|"x-post"|"news"|"other", foundAt? }`. Each writes one row in `radar_marks` or `radar_missed` and nothing else (insert only, body-size and JSON handling as `meme-angle.post.ts`); a type test shows the War Room's Datastore view can insert nothing else. The worker applies marks (an Ignore hides the Trend whatever it does; Seen stores the score at that time so "changed" has something to compare with). The Missed term goes through `cleanTerm` and `radarKey`; a duplicate key inside 7 days is a 409.
- **Find box.** `GET /api/radar?q=<text>`: the text is cleaned by `searchWords`, matched against stored keys and subjects with plain `LIKE` on escaped input or an in-memory compare, never a RegExp; read-only. It exists so the Operator can check "did the radar have this one" for a call by a human caller (measure 5).
- **Scorecard** (spec 8). Computed by `radar/scorecard.ts` from the tables, one block with a count beside every percentage:
  1. **Lead time.** For each Trend that gets a live clone (the ticket 16 test) with liquidity of $10K or more and a market cap of $20K or more within 24 hours of its first flag: the minutes from the radar's first flag to that clone's pair creation time, and against the Operator's first Seen or Missed entry for the key. Share earlier and the median; target at least 60 percent and at least 60 minutes. The state-change times stored by ticket 01 are the source.
  2. **First source** per good Trend; a source never first in 14 days is listed.
  3. **Precision and noise.** Trends shown a day, the share with a Watch, Make ideas or Keep press (Watch and Make ideas appear when tickets 06 and 07 exist; count what exists), false flags a day (Ignored, or the model's "not a thing").
  4. **Untokenized check sample.** 20 random `untokenized` Trends of the last 14 days, each with a DexScreener search link (through `safeHttpUrl`); the Operator marks each "wrong" or "right" (`radar_marks` kind `check-wrong`/`check-right`); the block shows wrong of checked, the number of `taken` rows he marks "drained pool read as live", and the count of `not traced`.
  5. **Blind spots.** The Missed entries by where found, and how many of them the radar had at any time before the entry (the find box's rule), shown as numbers only.
  6. **Cost.** Per day: haiku runs and Est. usage against the cap, source failures, and (stage B) X API dollars against the cap; the Operator's minutes (he can type one number a day, a mark row).
  7. The go-or-stop line for stage A (spec 8, first two bullets) is computed and shown as "passes" or "does not pass" with each part's number; the verdict is the Operator's.
- The block shows the 14-day window by default and a start date, so a later window can be read.

## Acceptance criteria

- [ ] **API** (`apps/warroom/server/test/radar-marks.test.ts`): a good body returns 200 and one pending row; wrong types, extra keys, an unknown kind, an empty term, a non-JSON or oversized body are 400 with nothing stored; a duplicate Missed key inside 7 days is 409; the War Room process writes no radar table other than the mark and Missed rows (checked on the DB); a GET of the page, of `/api/radar` and of the find box leaves every table unchanged.
- [ ] **Worker** (`radar-marks-job.test.ts`): Ignore hides a Trend permanently, whatever its score does; Seen stores the score at that time and a later rise shows "changed"; marks for an unknown Trend are refused and recorded.
- [ ] **Find box** (`radar-find.test.ts`): a term finds its stored Trend by key and by subject; `%`, `_`, quotes and a 10,000-character query are harmless; no RegExp is built from the text.
- [ ] **Scorecard measures** (`scorecard.test.ts`, a fixture database with known times): lead time gives the share and median for a hand-computed set (include one Trend with a clone created before the flag, which counts as late, and one with no clone, which is left out of the denominator); first source per good Trend; the false-flag count; the sample draws 20 distinct `untokenized` Trends from the window and a repeat draw is stable for the same day; wrong of checked; Missed counts by source; every percentage carries its n; with no data every measure says "no data", not 0 percent.
- [ ] **Stage A bar** (`scorecard.test.ts`): the passes or does-not-pass line is right on fixtures just above and just below each threshold (5 shown a day, 30 percent kept, 10 false flags, 2 wrong of 20) and shows the failing part.
- [ ] **Render** (`radar-render.test.ts`, `pnpm page:check --seed /radar`, seeded; add marked, ignored and Missed seed rows): buttons, the Missed form with `maxlength` and the server's reason on a refusal, the find box, the scorecard block with its empty state; keyboard: `--keys "focus=[data-test=radar-missed-summary],Enter,Escape" --watch "[data-test=radar-missed-form]"` opens and closes the form (the script blocks the submit); no overflow at 390 or 1240 px; a hostile Missed term renders as one escaped line.
- [ ] Type-check, `pnpm lint` and the full `pnpm check` pass, run once before the commit.

## Constraints

- Follow `docs/agents/worker-rules.md`. The War Room writes request and mark rows only (CODING_STANDARDS rule 1); every write is an explicit POST, never a side effect of a GET. No model calls here.
- Commit subject `Trend radar ticket 05: marks, the Missed form and the 14-day scorecard`, body ends with `Ticket: .scratch/trend-radar/issues/05-marks-missed-form-and-14-day-scorecard.md`. No `Closes #N`.

## Comments
