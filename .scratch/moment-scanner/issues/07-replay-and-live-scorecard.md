# 07: Replay on 2026-11-18 and 19, and the live scorecard
**Model:** sonnet / medium. A deterministic harness over hand-transcribed data and a set of counts on the page. No model, no X. The care is honesty about what sparse readings can and cannot show.

**What to build:** (a) a replay command that runs the scanner's own qualify rules over the readings the manual scans wrote down on 2026-11-18 and 19 and prints, per Moment, when the rules first flag it, when the manual scans first recorded it, and when the first coin was created; (b) a "Scorecard" block on the Moments page that computes the spec's measures from the live tables, so the two-week verdict is read off the page and not argued from memory. Useful alone: it says whether the thresholds are any good before and after the scanner runs live, and it is the gate for ticket 11.

Status: wontfix

**Blocked by:** 04
It needs the tiers, the trace and the first-$50K-clone time.

## Evidence and limits (state these in the command's output too)

- The inputs are the readings in `.scratch/research/gta6-post-release.md` (untracked in the main checkout; copy the numbers into a fixture, not the file) and the coin creation times in `.scratch/research/gta6-naming-lessons.md`. Readings exist only at the times of the manual scans, for posts the scans chose to write down. So the replay gives **an upper bound on lateness** (the rules cannot flag earlier than the first reading) and cannot measure false flags on posts nobody recorded.
- From the notes alone, several moments will not show a flag before their coin: the alien coin AL was created 13:47 and the first reading of FelpsCrypto's post in the notes is 13:55; the HULK coins were created 12:04 to 12:06 and the first reading of the giant post is 12:15; the dog coin came 12 minutes after its clip. The game plan's replay target (at least 4 of 5 before the winning coin) is therefore **not expected to be demonstrable from this data**. The harness reports the number it finds. A result under 4 of 5 is a data limit, to be written down as such in Comments, not a reason to change a threshold; the thresholds were set by hand on this same day, so the replay flatters them anyway.
- Dates: posted times decode from the status IDs in the notes; the harness does that, so the fixture holds IDs and readings only.

## Build

1. `packages/core/src/fixtures/moments/gta6-2026-11-18-19.json`: for each post the notes list with at least one reading: status ID, handle, the manual scan time and (views, likes) at it, plus which Moment it belongs to (hand-grouped, labelled as hand-grouped), the manual first-record time, and the first coin's name, creation time and cap at the time. Labelled hand-transcribed at the top; each entry cites the scan section it came from.
2. `packages/core/src/moments/replay.ts` and `pnpm moments:replay`: feeds the readings in time order through the same `qualify`, `rate` and tier functions the worker uses, with no clock of its own, and prints a table plus a summary: Moments flagged at all, flagged before the first coin was created, flagged before the manual first record, median lead against the manual record.
3. Scorecard (`moments/scorecard.ts`, one pure function over the tables, `GET /api/moments/scorecard`, a collapsed block on the page), for the last 14 days: Moments flagged (qualifying) and rising-only; ignored by the Operator and judged not a moment (the false-flag count, per day); Moments that got a real clone of $50K or more within 24 hours of their first flag, and of those how many were flagged before that clone's pair creation (the "found before the first $50K real clone" figure, with n shown); median lead of the scanner over the manual scans' record where both exist (the manual side is entered by the Operator on a small form, or left empty); precision (flagged Moments followed within 24 hours by a coin above $20K with at least $10K liquidity); ideas made, shortlisted, launched from Moments; loads a day against the cap and any STOP signal; judge runs and Est. usage a day. Every figure shows its n and its window; a figure with n under 5 says "too few".

## Acceptance criteria

- [ ] **Fixture** (`fixtures.test.ts`): every entry decodes to a valid time from its status ID and cites a scan; readings are in time order; the six moments of the 15:20 scan and the Mandy, furry, scooter, dog and Hulk entries are present.
- [ ] **Harness** (`replay.test.ts`): on the fixture, each Moment's first flag time is the earliest reading at which the rules fire and never earlier than the first reading; the summary counts are exactly what a hand calculation of the fixture gives (the test states the calculation in a comment for the five winners: dog, alien, Hulk, scooter, furry); a Moment with a single reading is flagged only if that reading alone meets a bar; the output says the data are sparse and that the result is an upper bound.
- [ ] **No tuning in the test:** the thresholds are imported from `moments/config.ts`; a test fails if the replay module defines its own number.
- [ ] **Scorecard** (`scorecard.test.ts`, real Datastore on a temp dir, seeded rows): each figure is computed on a seeded set whose answer is worked out in the test; n under 5 reads "too few"; the lead median ignores Moments without a manual record; the "before the first $50K real clone" figure counts a Moment only if the trace recorded a real clone of $50K or more; a drained lookalike never counts; an ignored Moment counts as a false flag once.
- [ ] **Page** (`pnpm page:check --seed /moments`, seeded; say so): the block renders every figure with n and window, collapsed by default, no overflow at 390 or 1240 px.
- [ ] **Run once** (Comments, not a test): `pnpm moments:replay` output pasted, with a plain reading of what it can and cannot say, and the number of Moments flagged before their first coin.
- [ ] Type-check, `pnpm lint` and the full `pnpm check` pass, run once before the commit.

## Constraints

- No X access, no DexScreener call, no model. The fixture is hand-transcribed data from notes, not a measurement; say so wherever it is shown.
- Commit subject `Moment scanner ticket 07: replay and live scorecard`, body ends with `Ticket: .scratch/moment-scanner/issues/07-replay-and-live-scorecard.md`.

## Comments
- Superseded by .scratch/human-researcher (ADR 0017: agents run only on Operator trigger)
- 2026-11-21 cos triage: ADR 0009, the Operator researches; the automatic moment loop stays off (ARGUS_MOMENTS)
