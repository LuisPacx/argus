# 17: page-check seed: refusals write nothing (tested), unique temp dir
**Model:** sonnet / effort: medium. Two small follow-ups to ticket 14 in `scripts/page-check-server.mjs` and its tests; no schema, ADR or dependency change.

Status: done

**Blocked by:** none. (Follow-up of `14-page-check-seed-option.md`, review note of 2026-11-16.)

## Problem

- Ticket 14's refusals box ("each exits 2 and writes nothing") stayed open because nothing tested the writes-nothing half for the refusals inside `startSeededServer` (live port, bad port, live DB path, busy port). Only the argument-parsing refusals had a test.
- The seed dir was `~/.cache/argus-scratch/page-seed-<pid>`. After a SIGKILL (no cleanup) a later run with a reused pid would reuse the stale dir and its old files.

## Acceptance

- [x] A test per refusal path in `startSeededServer` (live port, bad port, a DB path that `isLiveDb` says is live, a busy port) asserts it rejects with `refusal: true` and leaves nothing behind: the scratch base dir is not even created (`scripts/page-seed.test.ts`, "startSeededServer refusals write nothing").
- [x] The seed dir is a fresh `fs.mkdtemp` under the same `~/.cache/argus-scratch` parent (not `/tmp`), named `page-seed-XXXXXX`; refusal checks run before anything is created.
- [x] Normal runs still remove the dir: the slow-tier `--seed` test asserts the dir name matches `page-seed-<6 chars>`, the dir is gone, the process group is gone and the port is free.
- [x] Type-check, `pnpm lint` and the full `pnpm check` pass once on the committed tree; `pnpm page:check --seed --all` is clean.

## Comments

- 2026-11-17: written and implemented. A dir left behind by a SIGKILL is now an orphan with a unique name, never picked up by a later run (it is not cleaned automatically; delete `~/.cache/argus-scratch/page-seed-*` by hand if one shows up).
