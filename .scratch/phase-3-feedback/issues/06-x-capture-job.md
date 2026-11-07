# 06: X capture job
**Model:** sonnet / medium — builds on the spike's findings; pacing, locking and stop rules.

**What to build:** X fields appear on the Snapshots of the tokens argus chooses to capture. The worker runs the Playwright capture as a plain child process (no Claude in it) for population tokens, at most about 200 a day, early-traction candidates first. Each token's selection reason is stored so the bias can be modelled. Captures are paced, serial and jittered. On any login wall, challenge, lock or suspension signal the job stops for the day and notifies the Operator, with no retry. It never posts, likes, follows or messages. The X text is stored as untrusted data. If X is off, X fields are null and the Study works on website and chain.
Spec: sections 5, 6, 13, 14.

**Blocked by:** 02 Snapshot metadata and website at the fixed age, end to end; 05 X capture spike

**Status:** ready-for-agent

- [ ] Selection rule uses only signals known at capture time (initial dev buy, links present); the rule version and each token's reason are stored (tested)
- [ ] The daily cap is counted in code from config and cannot be exceeded; supports --dry-run, which opens no browser and writes no Snapshot
- [ ] One browser process per directory: the lock is taken, and the job refuses and reports when Chrome holds the directory (tested)
- [ ] Pacing is serial with jitter; the headless or headed mode follows the spike's verdict
- [ ] A challenge, login wall, lock or suspension signal stops the day's captures, notifies the Operator on Telegram, and schedules no retry until the next day (tested with simulated signals)
- [ ] No code path posts, likes, follows or messages (tested by the script using read-only navigation only)
- [ ] X text reaches later Claude runs only as delimited untrusted data; the sanitising is tested
- [ ] A feature switch turns X capture off, and Snapshots then store null X fields and the capture status "off"
- [ ] Study page shows X captures against the cap and the stop-for-the-day state; checked in a browser
