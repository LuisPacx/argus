# 10: A meme Proposal's 12 h life does not run while the worker is stopped
**Model:** sonnet / effort: medium. One new stored fact (when the worker was last alive), one change to a pure function and its caller, tests on a fake clock. Medium because the expiry date is also shown on cards and the clock-skew and boundary cases need care.

**Status:** done

## Problem

A meme Proposal closes 12 h after creation (`MEME_EXPIRY_MS`, `packages/core/src/expiry.ts:16`; GLOSSARY "Meme Proposal"; ADR 0013 amendment 2026-11-15; set by meta-redesign ticket 03, first built by missed-ideas ticket 06). The 12 h is wall-clock time, so it also runs while argus is stopped.

Observed 2026-11-17: argus was stopped about 12 h (user pause 11-16, restart 2026-11-17T04:41:32Z). On the first tick after restart, 04:41:54Z, `expireStaleProposals` (`expiry.ts:29`, called from the worker tick, `apps/worker/src/main.ts:196`) closed all six live meme Proposals (#165-176) with reason `stale`. The Operator never saw them: the War Room shows only live Proposals, and the worker made no new ones in between. The same pause already makes the Meta code say "nothing raised after a pause" (`stateMaxMinutes`, `meta/new-meta.ts:11`), so ideas for a Meta that was live before the pause are the one thing the restart destroys.

How expiry is computed: `Datastore` maps a row to `expiresAt = expiresAtFor(status, created_at (new) or status_since, kind)` (`datastore.ts:641`), a plain `since + ttl`. It reads no clock of the worker. The tick only does `expireStaleProposals(store, new Date())`.

How the worker knows it was down: it does not. Nothing persists "the worker was alive at T". `console.log("[worker] tick ...")` goes to the log file only. `brain_runs.heartbeat_at` exists but only for runs in flight (Builds), `source_polls.last_polled_at` is one row per Source, overwritten each poll (so after a restart it holds the first new poll, not the last old one, once ingest has run once). `meta_runs` has a row per Meta run, but it is a Meta fact, is pruned, and does not exist when `ARGUS_META` is off. So a stop is invisible to the expiry code today.

## Options

- **(a) Expiry counts only time the worker was running.** Persist a heartbeat (one row, `worker_alive_at`, written each tick) and a gap ledger: at each tick, if `now - worker_alive_at` is over a threshold (for example 10 min, well above the tick), insert a gap `[alive_at, now]`. A Proposal's expiry is `since + ttl + (the part of any recorded gap that lies after since)`. Nothing already stored is rewritten; expiry stays a pure function of stored facts, `expiresAt` on a card moves out by the gap, and a second restart adds a second gap.
- **(b) At startup, extend deadlines by the downtime.** Same heartbeat, but on boot write the gap into each live meme row (a new `expires_extra_ms` column, or rewrite `created_at`/`status_since`, which is wrong: it breaks the "age" shown and the ordering). Equivalent result to (a) with a row-by-row write that can half-apply; the gap ledger is smaller and idempotent.
- **(c) Reopen the ones closed at startup within N min.** No heartbeat needed, but the lifecycle has no reopen from `closed` (the state machine forbids it; ADR 0013 and `lifecycle.ts`), a close leaves a history row and Telegram/feedback noise, and N is a guess. It also does not fix a pause where the first tick comes later than N.
- **(d) Simplest: do not close a meme Proposal on the first tick after boot, and count the 12 h from the boot.** Needs only an in-memory flag and a `bootAt`. Wrong in both directions: a Proposal made at 11 h before the stop gets a fresh 12 h (live for 23 h of wall time) and a restart after a short 5 min stop also resets everyone.
- **(e) Do not close on a stale heartbeat.** Skip all closing for a tick when the heartbeat gap is over the threshold, then grant the gap. This is (a) with the arithmetic replaced by a delay; it still needs the heartbeat, so (a) is no more work and exact.

## Recommendation

Option (a): a one-row heartbeat plus a small gap ledger, and `expiresAtFor` takes the gaps. Smaller and safer than (b) (no rewrite of Proposal rows, idempotent, survives a crash during start), exact where (d) is not, and it does not need the Meta tables. Apply it to **meme Proposals only** (the 12 h life is the one that a pause can eat; the 48 h `new` and 7 day `shortlisted` lives of narrative Proposals are long enough that the Operator sees them, so they keep wall-clock expiry, which is also today's tested behaviour). The user confirmed meme only (see Decisions).

**What happens to a Proposal that would have expired during the stop anyway:** it is not closed on restart; it keeps its remaining running time (a Proposal made 11 h before the stop has 1 h of running time left, so it closes about 1 h after restart, not at once). A Proposal made before the stop and 12 h of running time old is closed on the first tick, as today.

## Acceptance criteria

- [x] A heartbeat is stored: the worker writes `worker_alive_at` (additive table, `CREATE TABLE IF NOT EXISTS`, idempotent, no migration of old data) every tick and at boot, and a gap `[alive_at, now]` is recorded when the previous heartbeat is more than a named constant (`WORKER_GAP_MS`, 10 min) older. A fresh database with no heartbeat records no gap (first boot).
- [x] `expiresAtFor` (or its caller in `datastore.ts:641`) pushes a meme Proposal's expiry out by the total length of recorded gaps that fall after its `since` (a gap that started before `since` counts only from `since`). Narrative Proposals are unchanged (decision 1). The extension has no cap (decision 2).
- [x] The 12 h refresh is held by the same gaps (decision 3): a Meta's refresh is due at its last started try plus `MEME_REFRESH_MS` plus the recorded gaps after that try. Test, fake clock: a Meta tried at T, worker stopped T+1 h to T+14 h, first tick after restart at T+14 h starts no refresh run and makes no second trio; the refresh is due at T+25 h. A New Meta event after the restart still runs (events bypass the gap, as before, under the 6 h trio guard).
- [x] Test, fake clock (beside `expiry.test.ts`): a meme Proposal created at T, the worker stopped from T+1 h to T+14 h (a 13 h gap), restart at T+14 h: the first tick after restart closes none; it is live until T+25 h (12 h of running time), and closes at the first tick at or after T+25 h. A second stop adds a second gap.
- [x] Test: a meme Proposal created before a stop, with 12 h of running time already spent at the stop, is closed on the first tick after restart, with reason `stale` (the downtime does not keep one alive that had already expired).
- [x] Test: a short gap below `WORKER_GAP_MS` (a slow tick, a `--once` run beside the daemon) records nothing and changes no expiry; two workers writing the heartbeat (daemon plus `--once`) never record a gap that spans a time one of them was alive.
- [x] Test: a clock that goes backwards (heartbeat in the future) records no gap and does not throw; an unreadable `worker_alive_at` is treated as no heartbeat.
- [x] `expiresAt` on the Proposal card and the "closes in ..." text (`apps/warroom/app/utils/meme.ts`) show the extended time with no page change; a render test with a gap shows the later time. No War Room page code needs a change otherwise (the page computes nothing).
- [x] The restart case that happened is reproduced as a test with the same shape: six live meme Proposals made 11 h before a 12 h stop are all live after the first tick and close about 1 h of running time later.
- [x] GLOSSARY (Meme Proposal, Proposal status: "expires after 12 hours" becomes "12 hours the worker is running") and ADR 0013 get an amendment line; `docs/architecture.md` through `pnpm docs:graph` if a stored fact appears in the graph.
- [x] Type-check and the full `pnpm check` pass, run once before the commit.

## Decisions (user, 2026-11-17)

1. **Scope:** meme Proposals only; narrative lives (48 h, 7 days) stay wall-clock.
2. **Cap:** none. A stop of any length extends the idea by that length.
3. **Refresh:** the 12 h meme refresh (`MEME_REFRESH_MS`) is also held by recorded downtime, so a restart makes no extra trio beside the kept ones.

No open questions remain.

## Comments
