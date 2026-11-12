# 12: Update docs/architecture.md for Phase 3
**Model:** sonnet / medium — a documentation edit against a known list.

**What to build:** The architecture document describes Phase 3 as the spec plans it, so a new reader sees the Study as a second pipeline beside the brain pass. Apply each change listed in spec section 16 to the document once the arch-doc branch has merged into main. Documentation only: no code, no behaviour change.
Spec: sections 12, 16.

**Blocked by:** The arch-doc branch merged into main

**Status:** done (8d4bfdf, c8df3ef)

- [x] Starts from the merged main version of the document, not the older one
- [x] Every item in spec section 16 is applied or deliberately skipped with a reason in the commit message
- [x] The header term list gains Study, Snapshot, Case, Cohort, Playbook, Organic migration and Fast migration, matching the glossary wording
- [x] The Study pipeline, the Playbook arrow into judge and propose, the study Brain task with its caps and no API fallback, and the War Room Study and review pages are described
- [x] The invariants section states the changed rules: the Chrome directory holds cookies, Study caps and Helius budget in code, no wallet/keys/transactions with read-only chain reads allowed, and the Argus X account never posts
- [x] The "not ported" X-cookie line is reworded to match ADR 0009
- [x] The Phase 3 entry is replaced by 3a and 3b and their done signals
- [x] Terms are consistent with the glossary, and no section contradicts another (glossary Fast migration set to 60 s by Operator decision 2026-11-08)
- [x] No files other than the architecture document are changed, except the glossary if a term is found missing
