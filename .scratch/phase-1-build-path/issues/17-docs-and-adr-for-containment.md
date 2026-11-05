# 17: Docs and ADR for containment
**Model:** sonnet / low — documentation only.

**What to build:** ADR `0005-builds-run-in-a-rootless-podman-container` (decision, rejected options, consequences), update `docs/architecture.md` §4 (command shape inside the container, scoped env paragraph) and §10 invariant 1, add the Operator setup steps (image build, network, token, resume command), and mark 07 findings HIGH2 and MED4 resolved in the journal.

**Blocked by:** 15

**Status:** ready-for-agent

- [ ] ADR records the Operator's answers to questions 1 to 9
- [ ] Architecture §4 and §10 match the implemented behaviour
- [ ] Ticket 10's acceptance run lists "image built, network created, token set" as prerequisites
