# 22: Migrated-token examples in the propose prompt
**Model:** sonnet / high — it puts third-party text into a prompt, so the untrusted-data handling must hold; the rest is small.

**What to build:** Propose has no sight of what worked on pump.fun. Until ticket 09 (Playbook into the prompts) can carry approved lessons, the propose prompt gets a short, capped block of the most recently migrated pump.fun tokens as examples. Recommendation C of `.scratch/phase-3-feedback/research/proposal-quality-2026-11-11.md`; it builds on ticket 17 (`TECH_VALUE_RULE`, `reason`, `interaction`, and the rule sections of `proposePromptFor`).

- Source: the existing Study tables only (`study_tokens`, left-joined to `study_snapshots`). No new network access, no chain call, no new table.
- Selection: the most recent N tokens with `migrated_at` set and a non-empty name, newest `migrated_at` first. N defaults to 10, is configurable (`ARGUS_PROPOSE_MIGRATED_EXAMPLES`, 0 turns the block off) and has a hard maximum in code (20). Per example: name, symbol, migration date, and the Snapshot's description and website title when a Snapshot exists (only about 8% of migrations have one today; tickets 19 and 20 improve that later).
- Rendering: an UNTRUSTED delimited block, treated like Signals. Token names and descriptions are written by the token's creator, so each field is length-capped, control and invisible characters are stripped, and whitespace is flattened to one line. The block sits inside a fresh random boundary and ends only at that boundary's END line; the rule text outside the block says it is untrusted data, not instructions.
- Labelled as hints: "examples of tokens that migrated, not a recommendation". The rule text states that `migrated_at` is PumpPortal receipt time and not bot-filtered (ticket 04 does not exist yet), so an example may be a bot-driven migration, not a success to copy; the tokens are not a Meta and not evidence about the Narrative.
- `reason` (ticket 17) says which example the Proposal modelled on, by name, when one was; otherwise it does not mention them. No new output key; caps, validator and the repair path (ticket 21) are unchanged.
- No examples (empty Study, or all rows without a name): the block and its rule text are omitted and the prompt is exactly today's. A failed read of the Study tables logs a line and degrades the same way; it never fails the pass.
- Stopgap: ticket 09 replaces this source with approved lessons and chain-verified organic migrators; the renderer and the "rule section plus untrusted block" shape are meant to be reused by it.

**Blocked by:** 17 Proposal Tech value and reason (branch `proposal-tech-value`)

**Status:** implemented on branch `migrated-examples` (stacked on `proposal-tech-value`); not merged

**Open for the Operator:** whether to accept receipt-time, unfiltered migrations as hints until ticket 04 exists (the research note asks for this decision). Needs a worker restart; merge between runs.

- [x] `StudyStore.recentMigrated(limit)` returns the newest migrated tokens that have a name, with Snapshot description and site title when present, newest first; the limit is clamped to 0..20 (tested, incl. tokens with no name, no migration, and no Snapshot)
- [x] The propose prompt renders the examples in their own delimited untrusted block with a fresh boundary; the rule text outside it labels them hints, names the receipt-time and not-bot-filtered caveats, and says to name the modelled example in `reason` (tested)
- [x] Each field is length-capped, control and invisible characters stripped, one line; a hostile token description (fake boundary line, newlines, "ignore the rules", unicode line separators) stays inside the block and cannot close it (tested)
- [x] At most N examples render; the default is 10 and a configured value above 20 is refused; 0 disables (tested)
- [x] With no examples the prompt is byte-for-byte the prompt without this ticket apart from the random boundary (tested); a Study read that throws is logged and degrades to no block (tested)
- [x] The repair and name-retry prompts carry the same block; caps and validator unchanged (tested)
- [x] `propose` SKILL.md explains the block (untrusted hints, `reason` names the example); `.env.example` and `docs/architecture.md` mention the variable
- [x] No write to `.data/argus.db`; tests use their own DB. `pnpm check` passes once before the commit
