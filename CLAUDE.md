## Agent skills

### Issue tracker

Issues and specs live as markdown files under `.scratch/<feature>/`. See `docs/agents/issue-tracker.md`.

### Domain docs

Single-context: one `GLOSSARY.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.

### Worker rules

Agents that edit this repo follow `docs/agents/worker-rules.md`.

## Context discipline

- Read big files in parts (offset/limit) and grep before reading; never read a whole log, lockfile or generated file.
- Send long command output (tests, builds, logs) to a log under `~/.cache/argus-scratch/` and `tail` it; never paste full output into the conversation.
- Reports to the orchestrator: at most ~10 lines, outcome first, then evidence (command and result, files, SHA); findings go on the ticket, not in the report.
