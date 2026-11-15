# 11: A headless page check, so a browser box can be verified without a human's Chrome
**Model:** sonnet / medium. One small script around a library the repo already pins, plus a doc line and a test of the pure parts; nothing here sets a data model or touches the live app.

**What to build:** `pnpm page:check <path> [--port N] [--out DIR]` opens one local War Room page in a headless browser with a fresh throwaway profile, at desktop (1240 px) and phone (390 px) widths, and writes a full-page screenshot per width, the console errors and the HTTP status. Cos and workers use it to close "browser check" boxes without a human browser. Why now: on 2026-11-14 the phone-width check of ticket 10 failed because resizing the user's real Chrome window did not shrink the viewport, and the user ruled that his Chrome profile must never be used again for these checks.

**Status:** open

**Blocked by:** none.

## Decided by the user (2026-11-14), not to be reopened

- His Chrome profile is never used. Neither is the Argus profile (`~/.local/share/argus/chrome`, the X capture login): a page check never reads or writes either directory. The check uses a fresh profile each run and deletes it.
- A real viewport width, not a resized window: the page is opened with the width set on the browser context.

## What is there today (checked 2026-11-14)

- **Driver:** `playwright-core` 1.65.0 is already a devDependency of `packages/core` (`package.json:8`, used by `packages/core/scripts/x-capture-spike.mjs`, which opens the Argus profile as a persistent context) and is in `pnpm-lock.yaml` and `node_modules/.pnpm/playwright-core@1.65.0`. It ships no browser. Puppeteer is not a dependency (only a global `~/.cache/puppeteer` of Chrome and chrome-headless-shell builds that no repo file uses).
- **Browser binary:** 1.65.0 expects Chromium revision 1254 (Chrome for Testing 158) under `~/.cache/ms-playwright/`. That cache holds only the older revision 1194: `chromium_headless_shell-1194` (323 MB) and `chromium-1194` (597 MB), so a plain `chromium.launch()` fails today with "executable doesn't exist". Playwright's non-persistent `launch()` makes its own temp profile, which is what we want. System Chrome (`/usr/bin/google-chrome`) exists but is not used: it is the user's browser.
- **Install cost if we want the matching revision:** `pnpm exec playwright-core install chromium-headless-shell` downloads roughly 100 MB and unpacks to about 320 MB in `~/.cache/ms-playwright`, once, on the home disk (not /tmp). No new npm package, no lockfile change beyond a root devDependency line (below).
- `scripts/warroom-pages.mjs` (`pageRoutes`) already lists the pages; `scripts/dev-server.mjs` starts a War Room. The check does not start a server: it is pointed at one that is running.

## Design (the ticket writer's choice, the user can overrule)

- **Script:** `scripts/page-check.mjs`; `"page:check": "node scripts/page-check.mjs"` in the root `package.json`; add `"playwright-core": "1.65.0"` to the root devDependencies (same exact pin as core, so the lockfile only gains an importer entry and `scripts/` resolves it without reaching into `packages/core`).
- **Browser choice:** the Playwright-expected revision if installed; else the newest `chromium_headless_shell-*` in `~/.cache/ms-playwright` (today 1194), passed as `executablePath`; else exit 2 printing the install command above. Never `google-chrome`, never a `channel`. `--browser PATH` overrides. The chosen binary and its version are printed so a screenshot is traceable. Headless shell is enough for layout checks; if a page needs a feature it lacks, the ticket that finds out switches to full `chromium-*`.
- **Arguments:** `<path>` (default `/`), `--port` (default 3000, the dev-server default; read it from `dev-server.mjs` rather than retyping if it exports one), `--out DIR` (default: the session scratchpad given by env `CLAUDE_SCRATCHPAD`, else `$TMPDIR/page-check`; `TMPDIR` is `/var/tmp`). Output files `<slug>-1240.png`, `<slug>-390.png` and `<slug>.json` (`{ url, status, widths, consoleErrors, pageErrors, failedRequests, browser, exit }`); the same summary is printed. The script refuses an `--out` under `/tmp` and an `--out` inside `~/.local/share/argus` or any Chrome profile directory.
- **Widths:** 1240 and 390, set as the context viewport (390 x 844, device scale factor 1, `isMobile` true for the phone). It also records `document.documentElement.scrollWidth` at each width and reports "horizontal overflow" when it exceeds the viewport, because a page that scrolls sideways at 390 px is the very thing the phone check exists to catch (ticket 10 notes the graph scrolls sideways under 1206 px on purpose, so overflow is a printed warning, not a failure, unless `--strict-overflow`).

## Constraints

- **Local only:** the URL is always `http://127.0.0.1:<port><path>`. The script takes no host argument, refuses a `<path>` that is an absolute URL or starts with `//`, and a Playwright route handler aborts any request whose host is not `127.0.0.1` or `localhost` and records it as a failed request (so a page that loads a remote font or image shows up as a finding, not a silent fetch).
- **Read-only:** it navigates, waits for load and network idle, and screenshots. No clicks, typing, form submits or scripted state changes; the one `evaluate` reads sizes. A later ticket may add named, read-only interactions (open a panel); anything that submits needs its own ticket.
- **Exit code:** 0 only when the document status is 2xx at both widths, there are no console `error` messages, no uncaught page errors and no failed local requests (status 4xx/5xx for any request counts). Otherwise 1; 2 for usage or missing browser. Screenshots are written even on failure.
- **Clean up:** the browser is closed and any temp profile deleted in a `finally`, including on SIGINT/SIGTERM; nothing is written outside `--out` and Playwright's own temp profile.
- **One browser at a time:** widths run one after another on one browser, never in parallel, and the script holds the machine's test slot (`scripts/test-slot.mjs`) for its run so it counts against the same two-at-once limit as the checks. It is not run inside `pnpm check`.

## Acceptance

- [ ] `pnpm page:check / --port N` against a running War Room writes the two screenshots and the JSON, prints the summary, and exits 0 on a healthy page.
- [ ] A test (`scripts/page-check.test.ts`, fast tier unless it spawns a browser; a browser-launching test goes in `SLOW_TESTS`) covers the pure parts: URL building and refusal of other hosts and `//` paths, the `--out` refusals (`/tmp`, the Argus and Chrome profile directories), slug and file names, the pass/fail decision from a recorded result (non-2xx, console error, page error, failed local request), and the browser-choice order over a fake cache directory.
- [ ] One recorded run in Comments: a throwaway local server (`node` on a port, serving one page that logs `console.error` and a 404 image) fails with exit 1 and names both; a healthy page exits 0. No temp profile remains afterwards (`ls` of the profile dir shown), and neither the user's Chrome nor `~/.local/share/argus/chrome` was touched (their modification times unchanged).
- [ ] A line in `docs/agents/worker-rules.md`: "Browser boxes on a War Room page: run `pnpm page:check <path>` (headless, throwaway profile, 1240 and 390 px) and cite the screenshots and exit code. Never open or resize the user's Chrome or use the Argus Chrome profile for it." Plus the same sentence in the worker brief template if one exists (grep `docs/agents/` for "browser check").
- [ ] Full `pnpm check` passes once on the committed clean tree.

## Which open browser boxes this closes

- **Ticket 10, "Browser check by cos at 1240 px and a phone width":** the layout half (reads left to right, nothing overlaps, no console errors, 200 on `/pipeline`, no sideways scroll beyond the documented one) can be cited from this script's screenshots. The numbers-match-`/activity` and panel-by-mouse-and-keyboard parts need interaction and live data: they stay with cos until read-only interactions exist (slices b and c).
- **Tickets 07 and 09 browser boxes** (dialog after a dismissed Build; the stopped note after a dismissed running Build) need a real Build and its state; they stay human or Argus-profile, deferred by the user to the next real dismissed Build. This ticket does not change that.
- Tickets 05 and 08 boxes are already ticked.

## Commits

One commit after the full `pnpm check`. Subject `War Room ticket 11: <what changed>`; the body ends with `Ticket: .scratch/warroom-redesign/issues/11-headless-page-check.md` before the trailers. No `Closes #N`: this repo has no GitHub issues. No GLOSSARY.md line expected.

## Open questions

1. **Browser revision:** use the installed 1194 headless shell now (no download) or install the matching 1254 (about 100 MB, once)? Default: fall back to 1194 and print a "newer revision available" note; install 1254 only if a page renders differently.
2. **Test slot:** hold a test slot for the run (default above) or treat a screenshot as too light for that? Default: hold it; it is a real browser process.
3. **Strict overflow:** should phone overflow ever fail the run by default, once the `/pipeline` graph is made to fit? Default: warning only, per ticket 10.

## Comments
