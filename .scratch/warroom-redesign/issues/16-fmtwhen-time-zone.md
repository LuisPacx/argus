# 16: fmtWhen formats in UTC, not the host's time zone
**Model:** sonnet / effort: medium. One formatter in `apps/warroom/app/utils/format.ts` and one test file; no schema, ADR or dependency change.

**Status:** done

**Blocked by:** none. (Follow-up of 15, open question 3, decided 2026-11-16 as a separate ticket.)

## Problem

`fmtWhen(iso)` (`utils/format.ts`) builds its `Intl.DateTimeFormat` without a `timeZone`, and picks the "no year" or "with year" form by comparing `getFullYear()` (host zone) of the value and of `new Date()`. Used on `proposals/[id].vue` (created, updated, expires, "started"), `narratives/[id].vue` (started, last Signal, material change, Signals, research) and `utils/why.ts` (Signal times).

- Server render uses the server's zone, the browser hydrates in the viewer's zone: different text, so Vue logs "Hydration completed but contains mismatches". Nothing on the page says which zone it is ("6 Nov, 23:49" has no label), so the value is also ambiguous to the reader.
- The year switch uses host-zone years too, so around New Year the two sides can pick different forms.

No seeded run shows it because this machine's server and browser share a zone.

## Repro

Test `apps/warroom/server/test/fmtwhen-time-zone.test.ts`: import `fmtWhen` with `TZ=UTC`, `Asia/Tokyo` and `America/Los_Angeles`; the same ISO gives three different strings before the fix.

## Acceptance

- [x] `fmtWhen` output is identical in any host time zone, formatted in UTC and labelled, e.g. `6 Nov 23:49 UTC` (`6 Nov 2025 23:49 UTC` for another year), with the year decided in UTC.
- [x] The test pins `TZ` per case and fails before the fix, passes after.
- [x] `pnpm check` green once before the commit.
- [x] `pnpm page:check --seed` clean on the pages that use `fmtWhen` (if any War Room page markup changed: the text only changed).

## Comments

- Decision: UTC with a "UTC" label (same as `fmtUtc` from ticket 15), because the server cannot know the viewer's zone; a viewer-zone display would need client-only rendering.
