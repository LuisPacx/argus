# 16: fmtWhen shows the viewer's time zone after mount, fixed UTC before it
**Model:** sonnet / effort: medium. One formatter in `apps/warroom/app/utils/format.ts`, a clock argument threaded through `why.ts` and two pages, one test file; no schema, ADR or dependency change.

Status: done

**Blocked by:** none. (Follow-up of 15, open question 3, decided 2026-11-16 as a separate ticket.)

## Problem

`fmtWhen(iso)` (`utils/format.ts`) built its `Intl.DateTimeFormat` without a `timeZone`, and picked the "no year" or "with year" form by comparing `getFullYear()` (host zone) of the value and of `new Date()`. Used on `proposals/[id].vue` (created, updated, expires, "started"), `narratives/[id].vue` (started, last Signal, material change, Signals, research) and `utils/why.ts` (Signal times in the Why panel).

- Server render uses the server's zone, the browser hydrates in the viewer's zone: different text, so Vue logs "Hydration completed but contains mismatches". Nothing on the page says which zone it is ("6 Nov, 23:49" has no label).
- The year switch uses host-zone years too, so around New Year the two sides can pick different forms.

No seeded run shows it because this machine's server and browser share a zone.

## Decision (user, 2026-11-17)

Absolute times show in the VIEWER'S local zone, not UTC. The server cannot know the viewer's zone, so this follows ticket 15's client-only pattern: `fmtWhen(iso, nowMs)` returns the fixed UTC text ("6 Nov 23:49 UTC", `fmtUtc`) while `nowMs <= 0` (server and first client render), and after mount (`useNowMs()`) the viewer's zone with a hint from `timeZoneName: "short"` ("6 Nov 20:49 GMT-3"; "6 Nov 2025 20:49 GMT-3" for another year, decided in the viewer's zone against the client clock). The full UTC timestamp is in `title` and `datetime`.

## Acceptance

- [x] `fmtWhen(iso, nowMs)`: with `nowMs <= 0` the text is the fixed UTC form and identical in any host zone; with a real clock it is the viewer's zone with a zone hint, year decided in that zone.
- [x] `whyView(p, nowMs)` and the pages `proposals/[id].vue` and `narratives/[id].vue` pass the shared clock; each time carries the full UTC timestamp in `title` (and `datetime` on `<time>`).
- [x] The test `apps/warroom/server/test/fmtwhen-time-zone.test.ts` pins `TZ` per case; the UTC-text case failed against the previous host-zone formatter.
- [x] `pnpm check` green once on the committed tree.
- [x] `pnpm page:check --seed` on `/proposals/{tech}`, `/proposals/{metaMeme}`, `/narratives` and `/narratives/{id}` with no hydration warnings.

## Comments

- First attempt (commit 04a96aa) formatted in UTC with a "UTC" label; the user wanted the viewer's zone, reworked here in a second commit.
