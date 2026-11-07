# X capture through a dedicated logged-in browser

Status: accepted (Phase 3 spec, 2026-11-07; Operator decisions Q9, Q13, Q14). Replaces the architecture's "X returns later through the official API" for the Study. Not yet built.

The Phase 3 Study (`.scratch/phase-3-feedback/spec.md`) needs the X profile and recent posts of up to about 200 pump.fun tokens a day, captured at a fixed early age and stored as frozen Snapshots. Argus captures them with a Playwright script that opens a dedicated Chrome user-data directory (default `~/.local/share/argus/chrome`, created by `.scratch/phase-3-feedback/setup-argus-browser.sh`) where a new, Argus-only X account is logged in. The script saves text and raw artefacts; Claude only reads the saved Snapshots, never drives the browser. The Claude in Chrome extension is installed in the same directory for manual checks by the Operator. The Operator accepted the Terms of Service and account-lock risk below.

## Considered Options

- **Official X API, pay-per-use.** The only route X's terms allow. At about 100 studied tokens a day with 10 posts and 10 mentions each it costs roughly $330 to $630 a month (posts $0.005, users $0.010, per resource returned); even a matched subset of about 20 tokens a day is $66 to $126. That alone exceeds the $100/month Study budget. Rejected on cost; it remains the compliant path if the budget changes, behind the same capture seam.
- **Third-party X data APIs (twitterapi.io and similar).** About $20 a month at this scale, but they rely on scraping X, which X's terms forbid, and can vanish, be blocked or change price without notice. The ToS exposure is the same as the browser's and the dependency is worse. Rejected.
- **Claude in Chrome per token (Claude drives the browser in `claude -p`).** Spends a Claude run on every capture, which breaks "capture broad with no Claude, analyse narrow" (Q16); `claude -p --chrome` is not documented for unattended use, browser selection and site permissions can block runs, and the extension connection drops when its service worker idles. Kept for manual checks only.
- **A Playwright script on a normal profile or in a throwaway context.** Chrome 136 and later ignore remote-debugging switches on the default data directory, and a throwaway context has no login. Hence a dedicated, non-default directory and a dedicated account.

## Consequences

- **Terms of Service.** X's terms forbid access other than through its published interfaces and forbid scraping without written permission; browser automation of x.com is on the wrong side of that. The Operator knowingly accepted this for a dedicated account. The exposure is the account (rate limits, challenge, lock or suspension), not a personal one, and possibly the IP.
- **Containment of the risk.** A new account used only by Argus, with an authenticator-app second factor; about 200 captures a day, serial and paced; the script stops for the day, notifies the Operator and does not retry on a login wall, challenge or lock signal; it never posts, likes, follows or messages (architecture invariant 6, no fake organic interest). X data is optional: with it off, the Study falls back to website, metadata and chain data.
- **Secrets.** The directory holds the account's session cookies. It lives outside the repository, mode 700, and outside any backup that is shared. The wizard stores no password, phone, email or 2FA seed.
- **Operations.** One browser process may own the directory, so a manual "Argus Chrome" session and a capture run cannot overlap; the script checks and refuses. Whether X treats headless Chrome differently is unproven; a spike decides headless against headed (virtual display) before the daily job is trusted.
- **Untrusted input.** Captured X text is written by third parties; it reaches Claude only as delimited data with no tools, like Signals.
- **Not the helios scraper.** Architecture section 11 lists the helios X cookie scraper and burner-account machinery as not ported. This is a different, deliberately smaller thing (one account, read-only, capped), and that line should be reworded when the architecture document is next edited.
- **Seam.** Capture sits behind one function that returns the Snapshot's X fields, so the official API or a vendor can replace the browser without changing the Study.
