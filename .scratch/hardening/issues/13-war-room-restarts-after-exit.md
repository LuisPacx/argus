# 13: War Room restarts itself after an exit, and logs why it exited
**Model:** sonnet / effort: medium — one small supervisor script, a wiring change in `dev-server.mjs`, one test file.

**Status:** done (see Comments)

## Problem

On 2026-11-18 at 03:00:59 local (06:00:59Z) the War Room dev server exited with no error: its log ends with a normal render and Nuxt's "● Cleaning up..." (the shutdown message, so most likely a signal). Nothing restarted it, so it was down about 19 hours. The worker kept running. `dev-server.mjs start` spawns the process once, detached, and nothing watches it afterwards.

## Approach

`scripts/supervise.mjs`: a small Node supervisor loop. `dev:start` now starts `node scripts/supervise.mjs --name <warroom|worker> --run-dir .data/run -- <the same systemd-inhibit command>` instead of the command itself. The supervisor is the process group leader, so the pid file, the group SIGTERM/SIGKILL in `dev:stop` and the sleep lock (held by the inhibit wrapper only while the child runs) behave as before. The worker gets the same wrapper, which cost nothing extra.

- **Backoff:** restart after 1 s, 2 s, 4 s ... capped at 30 s for children that die young; a child that lived 60 s or more resets the backoff.
- **Cap:** more than 5 restarts inside 5 minutes and the supervisor logs "giving up", writes status `gave-up` and exits 1. A crash loop does not spin.
- **Exit log:** every child exit is one line in `.data/run/<name>-exits.log`: ISO time, name, `code=N` or `signal=SIG...`, uptime, and the action (restart #N in X ms, giving up, stopped).
- **Intended stop:** `dev:stop` (and the failed-start cleanup) writes `.data/run/<name>.stop` before the group SIGTERM. Only a SIGTERM that follows the marker ends the supervisor. A SIGTERM to the group without a marker (anything else signalling it) is logged ("without a stop marker") and the child comes back. This is what makes a stray group SIGTERM, the likely cause here, survivable.
- **Status:** `.data/run/<name>-supervisor.json` holds restarts, last exit and state; `dev:status` prints `restarts: N, last exit ..., exit log: <path>`, and says so when the supervisor gave up.

Why not systemd --user units: the repo's scripts do not use them (the start script owns the pid files, the log files, the `.env` loading and the `systemd-inhibit` wrap, and the tests and worker rules all go through it). Units would move the start path out of the repo, need install steps and a second way to stop. A supervisor loop inside the existing script keeps one start path and is testable with stand-in processes. Cost: a supervisor that is itself SIGKILLed (or a reboot) is not restarted; a reboot needs the Operator to run `pnpm dev:start`, as before.

## Acceptance

- [x] The War Room restarts automatically after any exit, with a backoff and a cap on restarts in a short window (5 in 5 min, then it gives up and says so).
- [x] Each exit is logged with time, exit code or signal and uptime to `.data/run/warroom-exits.log` (and `worker-exits.log`).
- [x] `pnpm dev:stop` stops it for good: no restart after an intended stop.
- [x] `pnpm dev:status` shows the restart count and the last exit.
- [x] The worker is supervised the same way.
- [x] `scripts/supervise.test.ts` kills a stand-in and shows it comes back, shows an intended stop does not respawn it, shows an outside group SIGTERM does, and shows the crash-loop cap holds.
- [ ] The cause of the 03:00 exit fixed: not found (see Comments). The restart plus the exit log is the mitigation; the next exit will name its signal and time.
- [x] `pnpm check` passes.

## Comments

**03:00 investigation (read-only, 2026-11-19).** Nothing found that signals the War Room at 03:00.
- `systemctl --user list-timers`: perf-sampler (every ~30 s), board-sync (every 2 min), tmp-quota-check, hermes-config-backup (hourly), systemd-tmpfiles-clean (15:11), drkonqi-coredump-cleanup (Mon 00:00), perf-weekly-check (Mon 10:00). None is scheduled for 03:00. `board-sync` did start at 03:00:59.xxx and finish 03:01:01 (journal), the same second as the exit, but it runs every 2 minutes all day and its script only calls `gh`; it has no kill, systemctl or node in it. Coincidence of the cadence, not a cause.
- `systemctl list-timers` (system): dnf-makecache (04:04), unbound-anchor (00:00), plocate-updatedb (~00:43), logrotate (~00:52), raid-check (Sun 01:00), fstrim (Mon 00:14), systemd-tmpfiles-clean (15:22). None at 03:00. dnf-automatic: not installed (`not-found`).
- `crontab -l`: none for the user. `/etc/cron.d/0hourly` runs `run-parts /etc/cron.hourly` at minute 01 of each hour; at 03:01:00 anacron started and scheduled `cron.daily` for 37 minutes later (03:37; START_HOURS_RANGE=3-22). `cron.daily` holds only brave-browser and google-chrome update scripts. `cron.weekly` and `cron.monthly` are empty. None signals node.
- tmpfiles.d: `/etc/tmpfiles.d` is empty; the clean timer runs mid-afternoon.
- Journal 02:59:30 to 03:01:30 on 2026-11-18: only perf-sampler, a Telegram thread priority change, a Chrome scope (03:00:38 to 03:00:51), board-sync, the hourly cron/anacron start and a yovoic alert. No OOM, no systemd stop or kill of a user scope, no logind session event (lid closed only at 03:25:38). The inhibit wrapper left no trace either.
- Start scripts: `dev-server.mjs` only signals on `dev:stop` or a failed start; `.claude/hooks/subagent-stop-sweep.sh` never kills (ticket 07). Nothing in them is time-based.
- Conclusion: not found. The remaining candidate is a signal sent by a person or agent session at that moment (a `kill` of the Nuxt group, or a `dev:stop` run by an agent), which no system log records. With this ticket the log will show the signal and the time of the next occurrence; the supervisor also records when the group got a SIGTERM that was not a `dev:stop`.

**Build.** `scripts/supervise.mjs` (new), `scripts/dev-server.mjs` (spawns through it, writes the stop marker, status), `scripts/supervise.test.ts` (new, slow tier). Existing live processes were started without a supervisor: `dev:status` shows no restart info for them until cos restarts them with `pnpm dev:stop` and `pnpm dev:start`.
