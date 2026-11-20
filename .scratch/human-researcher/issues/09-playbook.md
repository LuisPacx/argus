# 09: Playbook
**Model:** sonnet / medium — one summarising run and a versioned block read by two existing paths.

**What to build:** A **Rebuild playbook** button on the Research page. It condenses the Operator's Picks, his reasons and their outcomes into a versioned Playbook (a short text of what tends to bond and what does not). Each rebuild is a new version; old versions stay readable. Research (ticket 05) and meme-ideas (Make ideas on a Meta or a brief) read the latest version as a fenced block. Nothing rebuilds on a timer.

**Blocked by:** 04, 06

**Status:** ready-for-agent

- [ ] The button writes one request row; the worker runs one summarising Brain call over Picks, reasons and finished outcomes and stores a new Playbook version with its time and the Picks it was built from (tests with a fake Brain).
- [ ] With fewer than 10 finished Picks the rebuild is refused with the reason before any model call (test).
- [ ] Research and meme-ideas prompts include the latest Playbook as one fenced block under a fresh boundary, named untrusted (reasons are Operator text) and cut to a character cap; with no Playbook the prompts are unchanged from today (tests).
- [ ] The version used is recorded on each brief and each Proposal made with it, so a change in behaviour can be traced (tests).
- [ ] The Shadow pick prompt (ticket 08) does not read the Playbook until the Scoreboard text says what that does to the comparison; a test pins that it holds none now.
- [ ] A rebuild costs one run counted in the research budget and `brain_runs`; a second press while one waits is refused (tests).
- [ ] Type-check, `pnpm lint` and `pnpm check` are green.

## Comments
