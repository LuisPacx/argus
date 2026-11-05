# 10: Phase 1 acceptance run
**Model:** sonnet / medium — runs the definition of done live and records evidence; the Operator is present for auth.

**What to build:** Exercise the Phase 1 definition of done (§12) for real: a hand-entered Proposal is shortlisted, its Spec edited, approved, and without further input ends with a private GitHub repo, a working `<slug>.workers.dev` preview, status `built` and agent cost on the card. Also the forced failure, the on-chain Spec, dry-run and caps. Record real usage to answer the §13 question on Max-plan limits.

Operator prerequisites: `claude setup-token` exported as `CLAUDE_CODE_OAUTH_TOKEN`; `gh` and `wrangler` authenticated; re-check that `claude -p` still draws from the subscription (§13).

**Blocked by:** 08, 09, 15

**Status:** ready-for-agent

- [ ] A live run reaches `built` with a private repo, a responding preview and cost on the card; repo URL, preview URL and cost recorded under Comments
- [ ] Forced failure: one retry, then `build-failed` with a session_id that resumes in tmux
- [ ] An on-chain Spec ends in `needs-human`
- [ ] A dry-run end to end spawns nothing
- [ ] Budget and wall-clock caps are covered by tests (named under Comments)
- [ ] Subscription usage of the run recorded under Comments, and §13 updated
- [ ] Repos and previews created during the run listed for the Operator to delete
