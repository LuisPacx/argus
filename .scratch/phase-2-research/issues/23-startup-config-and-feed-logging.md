# 23: Worker logs its effective config at startup, plus PumpPortal and Study lifecycle lines
**Model:** sonnet / medium — one pure formatter, a few log lines, tests.

**What to build:** The 48h acceptance re-run check-ins read `.data/run/worker.log` and had to assume the caps and feed state. Operator decision 2026-11-09: the worker proves its own configuration and feed state in the log. Volume stays small: no per-message logging, no secret values.

**Status:** done (23f57da, 8153791 on main)

## Where it lives

- `packages/core/src/startup-config.ts` `startupConfigLine(env, facts)`; `apps/worker/src/main.ts` logs it once at startup (prefix `[config]`).
- `packages/core/src/sources/pumpportal.ts`: `[pumpportal] connect|subscribe|disconnect|reconnect|closed` lines, each with `conn=N` (sockets created) and `open=0|1`.
- `apps/worker/src/main.ts`: `[worker] Study started: ...` when the capture tick starts, `[worker] Study stopped` on shutdown.

## Acceptance criteria

- [x] One `[config]` line at startup: judge min Signals and runs/24h, propose caps, daily quota and research share, API fallback on/off, Study rule version, Study ages, Study captures/day cap, Telegram on/off (test).
- [x] Keys and tokens appear only as set/unset or on/off, never as values (test with fake key, bot token and chat id in the env).
- [x] PumpPortal logs connect, subscribe (streams), disconnect (code and reason) and reconnect (attempt and backoff), each with a connection id and open count (tests).
- [x] One "Study started" line and one "Study stopped" line; no per-message logging.
- [x] `pnpm check` passes.

## Comments
