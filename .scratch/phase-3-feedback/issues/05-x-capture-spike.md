# 05: X capture spike
**Model:** sonnet / medium — a bounded experiment against a live site, ending in a decision note.

**What to build:** The Operator gets an outcome note that decides whether X capture stays in 3a. The spike drives the dedicated Chrome directory with Playwright, logged in as the dedicated Argus X account, tries headless against headed (virtual display), and records which one X tolerates. It captures the profile page, recent posts and a ticker search for a few tokens, and shows how login walls, challenges, locks and suspension are detected. Nothing is posted, liked, followed or messaged. This is a spike: a small script and a note, not the daily job.
Spec: sections 6, 13, 14, 15 (slice 6).

**Blocked by:** The Operator has run setup-argus-browser.sh and created the dedicated X account (human step; the ticket cannot start until the Operator confirms both)

**Status:** done (ff357d2, 109fc05, c5dfae9)

- [x] The script opens the dedicated directory as a persistent context and refuses to start if Chrome already holds it (one process per directory, lock tested) (manual run on a throwaway directory, recorded in 05-outcome.md; no automated test)
- [x] Headless and headed (virtual display) are each tried over a small number of captures, with the result recorded for each (headed ran on Chrome's headless Ozone platform; Xvfb is not installed, see 05-outcome.md)
- [x] Detection signals for login wall, challenge, lock and suspension are written down, and the script stops on any of them without retrying (tested offline; never fired live: `packages/core/src/x-capture/detect.test.ts`)
- [x] Saved fields are listed: profile fields, recent posts with time and counts, ticker and name mentions, capture status, plus a raw HTML or screenshot artefact
- [x] Total captures during the spike stay under a small stated number and are paced and jittered
- [x] The directory is outside git and has mode 700 (checked and noted); no cookie or credential appears in the note or the repo
- [x] An outcome note (issues/05-outcome.md) states: headless or headed, detection signals, observed risk to the account, and a clear verdict "X stays in 3a" or "X leaves 3a"
