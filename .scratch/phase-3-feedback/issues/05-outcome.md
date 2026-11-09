# 05 outcome: X capture spike

Recommendation: **X stays in 3a, headless.** Headless Chrome and headed-virtual Chrome were both tolerated; no login wall, challenge, lock or suspension appeared in 12 page loads. Treat this as thin evidence (see "Limits"): keep the stop-on-signal rule and the daily cap.

## What ran

- Script: `packages/core/scripts/x-capture-spike.mjs` (dev dependency `playwright-core` 1.65.0 in `@argus/core`, exact pin). Browser: the system Google Chrome 155 (`/usr/bin/google-chrome`); no Playwright browser download.
- Persistent context on `~/.local/share/argus/chrome`, logged in as the dedicated Argus X account (account handle and name not recorded here). Every capture reported a logged-in session.
- 12 X page loads in total, one run per mode, serial, 9 to 22 s jitter between loads, two small wheel scrolls per page. Only `goto`, scroll and DOM reads: no click, type, post, like, follow or message.
- Targets per mode: public profiles (Bonk, Dogecoin and pump.fun's account), one made-up handle (expected "not found"), and two live ticker searches (`$BONK`, `$WIF`).

| Mode | Loads | ok | not found | blocked / stop signal |
|---|---|---|---|---|
| headless (`--headless`, new headless) | 6 | 4 (2 profiles, 2 searches) | 2 (`pumpdotfun` handle does not exist; made-up handle) | 0 |
| headed-virtual | 6 | 5 (3 profiles, 2 searches) | 1 (made-up handle) | 0 |

"Headed-virtual" is the full headed browser on Chrome's headless Ozone platform with `DISPLAY` and `WAYLAND_DISPLAY` unset, because Xvfb is not installed here (only Xwayland, which has no headless mode). A real virtual display (`xvfb-run`) was not tried; headed on the real desktop was not tried (it would pop a window on the Operator's screen). Page loads took 7 to 10 s each in both modes; there was no visible difference in tolerance.

## Detection signals (implemented in `detect()`)

The script stops on the first STOP signal and never retries. Checks are URL, DOM and text only.

| Signal | Class | How detected |
|---|---|---|
| Login wall | STOP | URL `/i/flow/login` or `/login`; no logged-in nav (`AppTabBar_Home_Link`, `SideNav_AccountSwitcher_Button`) together with a login or signup button; text "Sign in to X" / "Don't miss what's happening"; or simply no logged-in nav |
| Challenge | STOP | URL `/i/flow/...` other than login; text "Verify your identity", "unusual activity", "Help us keep your account safe"; arkose, recaptcha or hcaptcha iframe; `ocfEnterTextTextInput` |
| Lock | STOP | URL `/account/access` or `/account/locked`; text "your account has been locked" |
| Own suspension | STOP | URL `/account/suspended`; text "your account is suspended" |
| Rate limit | STOP | text "Rate limit exceeded" |
| Not found | recorded | text "This account doesn't exist" (worked: made-up handle) |
| Target suspended | recorded | "Account suspended" on a profile URL |

The classification and stop loop live in `packages/core/src/x-capture/detect.mjs` and are tested offline with synthetic page facts (`detect.test.ts`: each STOP signal stops the run with the right status, no further loads, no retry; a normal logged-in page is not flagged). None of the STOP signals fired live, so they are written from X's known behaviour and are **untested against a real wall**; only the logged-in check and "not found" were exercised live. They must be hardened when a real one is seen. The "no logged-in nav means login wall" fallback is the safety net.

## Saved fields

- Capture: status (ok, not_found, suspended, login_wall, challenge, locked, own_suspended, rate_limited, error), signals, HTTP status, final URL (query stripped), logged-in flag, elapsed ms, capture time, mode.
- Profile: display name, bio, joined date, followers, following (text and parsed number). Worked for Bonk and Dogecoin.
- Recent posts (up to 10 captured, 6 to 9 seen after two scrolls): text, ISO time, and the counts string from the post's aria-label ("44 replies, 39 reposts, 185 likes, 4 bookmarks, 18856 views"). Search results for new posts carry fewer counts (some show only views).
- Ticker/name mentions: count of captured posts containing the ticker (naive substring match; the job needs word-boundary matching).
- Raw artefacts: full HTML and a PNG per load, plus `results.json`, in `~/.cache/argus-scratch/x-spike/<run>/` (outside git, files mode 600, dirs 700). The HTML contains the Argus account's own nav and handle, so artefacts are as sensitive as the session and must not be shared.

## Lock and directory checks

- One process per directory: with a Chrome running headless on a throwaway directory under `~/.cache/argus-scratch/`, the script exited 3 with "REFUSED: a Chrome process (pid ...) already holds ...". It reads Chrome's `SingletonLock` symlink and checks that the pid is alive (a stale lock is allowed through). The real profile was never opened twice; after the runs it held no lock.
- The script also refuses unless the directory is mode 700 and outside the current repository. The real directory was mode 700 (checked on every run). It is under `~/.local/share`, outside git. No cookie or credential is read, printed or written by the script or this note.

## Observed risk to the account

Nothing observed: no warning banner, challenge, forced re-login or rate-limit text across 12 loads in about 6 minutes of activity. That is a small sample at about 1/15 of the planned 200/day; it says X does not reject a logged-in Chrome (headless or not) at low volume, not that 200/day is safe. The Terms of Service exposure in ADR 0009 is unchanged. Playwright was launched with `--enable-automation` removed, but `navigator.webdriver` and similar automation hints were not examined.

## Limits and what the job (ticket 7) still needs

- Volume and pacing at 200 captures a day were not tested; ramp slowly (start with a few dozen a day) and watch for the first STOP signal. Capture happens at token age 5 minutes (settled), which the spike did not simulate.
- X's DOM (`data-testid` selectors) is undocumented and changes; the extractor needs fixture tests on saved HTML and a "selectors found nothing" status distinct from "ok with zero posts".
- At 5 minutes most tokens have no X account or a brand-new one; "not found" and empty profiles will be common and must be a normal result.
- Sessions expire: the first login wall is the expected end of a session, and recovery is the Operator re-logging in through the Argus Chrome launcher.
- A true virtual display (Xvfb) is a cheap install if headless is later flagged; headed-virtual via the headless Ozone platform worked meanwhile as a fallback with the same script (`--mode headed-virtual`).

## Verdict

**X stays in 3a**, run headless by default, with the stop-and-notify rule, a low initial daily cap and a clean fallback to null X fields.
