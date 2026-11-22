# 01: Shared term module, so one text-matching rule serves widen and the Meta blend pass
**Model:** sonnet / medium — a small extraction with Unicode normalisation and existing tests to keep green.

**What to build:** Take the term-matching rule (`termMatches`, with its stem and word-boundary behaviour) out of the widen module into a shared module that both widen and the Meta code can import. Add Unicode NFKC normalisation before matching, so full-width letters, compatibility forms and decomposed accents match their plain spellings. Behaviour for plain ASCII input stays exactly as today: a term of 4 or more characters matches anywhere, a shorter stem matches only a whole word, the start of a word, or the end of a word with at least 4 characters before the stem ("CATEMAS", "Bullmas" match "mas"; "Thomas" and "Xmas" do not). The module is plain code, linear in the text, builds no pattern from the term and has no I/O. Widen keeps its public behaviour and imports the shared rule; nothing else changes. Background: `.scratch/cos.md` "Christmas plan", ADR 0018.

**Blocked by:** none

Status: ready-for-agent
- [ ] The matching rule lives in a shared module and widen imports it; widen's own tests pass unchanged.
- [ ] "CATEMAS" and "Bullmas" match the stem "mas"; "Thomas" and "Xmas" do not; the stem also matches a whole word "mas" and the start of a word.
- [ ] A full-width spelling (for example "ＳＡＮＴＡ") matches the term "santa", and a decomposed accent matches its composed form, in both directions.
- [ ] A term of 4 or more characters still matches anywhere in the text, case-insensitively with whitespace runs collapsed.
- [ ] Matching stays linear (a long input with a short term returns without a measurable stall) and builds no pattern from the term.
- [ ] Type-check, `pnpm lint` and `pnpm check` are green.

## Comments
