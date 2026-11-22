# 07: A Meta does not drop out and re-fire on a short dip (exit hysteresis)

Status: ready-for-agent

Model: sonnet, effort high

## Problem

Live runs 627-637 (see 06-live-check-christmas-meta.md Comments): Christmas was a Meta at run 627 (g24 11, creators 45, leader $snowball), absent at 628-629, "watching" at 630-636, and a Meta again at 637, which fired a second New Meta event. The Meta rule has no exit hysteresis, and the subject lost $snowball between runs, so one narrative produced two New Meta events in a day.

## Acceptance criteria

- [ ] A Meta stays a Meta (or a clearly marked cooling state) through a short dip below the entry thresholds; exit needs a lower bar or N consecutive runs below (pick and justify the rule in an ADR).
- [ ] Re-entering after a dip within the cooling window does not emit a second New Meta event for the same key.
- [ ] A subject's leader token leaving the subject does not by itself end the Meta; explain how $snowball dropped out and fix it if it is a stabiliser bug (tickets 02/03).
- [ ] Tests replay the 627-637 sequence (from the live DB, read-only) and show one Meta episode, one New Meta event.
- [ ] `pnpm check` passes.

## Comments
