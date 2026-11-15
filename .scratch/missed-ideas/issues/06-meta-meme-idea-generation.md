# 06: Meta meme idea generation (Hot now Metas produce 3 `meme` Proposals)
**Model:** sonnet / high. A new Brain task with untrusted input, a Proposal kind through the store, the state machine and the War Room, a cap and a name-copy rule. It decides what argus suggests to the Operator.

**What to build:** when a Meta is **Hot now** (ticket 03), one sonnet run reads the Meta and its context and returns 3 meme ideas, stored as Proposals of kind `meme` (ticket 05). The Operator sees them under the Meta on `/meta` and in the Proposals list, and can Shortlist, Dismiss with a reason, or read Why. This is the fix that would have produced an idea on 2026-11-12: the `jensen` Meta (256 tokens, 141 creators in 24 h, rank 2) was the market's answer and nothing turned it into a suggestion.

**Status:** open

**Blocked by:** 03 (the Hot now event is the trigger) and 05 (the ADR and GLOSSARY define the kind). Also follows 04 (Rubric v3 legitimacy text). Agreed order: warroom-redesign/10 slice c, then 03, 04, 05, **06**, 07.

Origin: `.scratch/missed-ideas/issues/01-nvidia-ceo-miss-gap-and-fixes.md`, answers Q1, Q2, Q5, Q9, Q10, Q11, Q14 (2026-11-14).

## Decisions already made (do not reopen)

- **Trigger:** generate only when a Hot now event exists (ticket 03), at most **once per Meta per 6 h**. Nothing else triggers it: RSS and news are context, not a trigger (Q2).
- **One sonnet run per trigger, 3 ideas.** Its own cap of **40 runs a day**, taken from the research budget (counted in `brain_runs` and the research quota, as the judge is). Budget spent or rate-limited ends the pass without error.
- **No Spec, no Build, no Rubric score.** 6 h life in `new` unless shortlisted (ticket 05).
- **An idea (Q14):** name, ticker, angle (the joke and why now), how it differs from the leader, a short description, an X first-post hook, an image idea as text, risk labels (for example "real person"), evidence links (the Meta's top tokens and the matching news). No image or logo generation.
- **Measured, no name copies (Q5):** a name or ticker that copies a token already in the Meta group or in DexScreener results is rejected by the distinct-name rule (`packages/core/src/beta/distinct-name.ts`, with `distinctOrRetryOnce`: goes back once with the offending names listed, then fails closed). The room-left ranking (`packages/core/src/beta/room-left.ts`) is an input: it is shown to the prompt as a reason, not a gate on generation.
- **Legitimacy** follows Rubric v3 (ticket 04): satire about a public figure is fine and is labelled; impersonation, fraud, and hate or harassment are not generated.
- **War Room only.** argus never launches, signs or spends (ADR 0002).

## What to build

- **Store:** additive, idempotent migration (rehearsed on a `.backup` copy, deleted afterwards): `proposals.kind TEXT NOT NULL DEFAULT 'narrative'`, `meta_label`, `meta_snapshot` (JSON: the Meta row, its run and the matching news as stored, immutable once written), the idea fields (angle, difference, hook, image idea, risk labels as JSON). A `meme` Proposal has `narrative_id` NULL and no `score_id`. A unique index allows one live (`new` or `shortlisted`) trio per Meta group key per 6 h window.
- **Brain task `meme-ideas`** (a `SKILL.md` and a prompt builder beside `propose.ts`; ADR 0001): input is one Meta row, its top 8 tokens, matching news (context), the existing names to avoid and the legitimacy text from the Rubric. All creator-written and news text sits inside a fresh random boundary named as untrusted data. Output: one JSON object with 3 ideas; `parseMemeOutput` refuses a missing field, an over-long field, a bad ticker, markup, control characters, a copy of an existing name, and a missing risk label when the Meta subject is a named real person.
- **State machine:** statuses used are new, shortlisted, dismissed, closed (expired). The spec, approve and build commands are refused for a `meme` with a clear message. Dismiss takes a reason, as for a Narrative Proposal. Collision checks (`collision.ts`) run on the name as for any Proposal.
- **Switch:** `ARGUS_MEME_IDEAS`, default **off** until the Operator turns it on; a dry run never calls the Brain.
- **War Room:** a `meme` pill, a list filter by kind, the ideas under each Meta on `/meta`, the Proposal page with the idea fields, the Meta numbers from `meta_snapshot` and the evidence links. All text as text, links only through `safeHttpUrl`.

## Acceptance

Offline in `pnpm check` (fake Brain, fake DexScreener).

- [ ] **Trigger and cadence.** A Hot now event starts one run; a second event for the same Meta inside 6 h does not; 40 runs a day is the cap and the 41st is refused with the reason recorded; budget exhaustion or a rate limit ends the pass cleanly (tested with a counting fake).
- [ ] **Output validation.** `parseMemeOutput` accepts a valid 3-idea object; refuses each bad case listed above; hostile token names and headlines (`</boundary>`, "ignore previous instructions") cannot end the boundary (tested).
- [ ] **Name copies rejected.** Exact name, exact ticker, a name differing by case, `$`, punctuation, emoji or zero-width characters, and a name one edit away from a token in the group are rejected; the retry-once-then-fail-closed path works with a fake Brain; a 10,000-character name and RegExp metacharacters run in linear time with no dynamic RegExp (tested).
- [ ] **Kind, migration and lifecycle.** The migration is additive and idempotent, old Proposals read `narrative`, rehearsed on a `.backup` copy; a second live trio for the same Meta inside the window is refused; a `meme` in `new` expires after 6 h while a Narrative Proposal keeps 48 h; spec, approve and build are refused for a `meme`; Shortlist, Dismiss with a reason and Why work through the real command path (tested).
- [ ] **The 2026-11-12 case.** A fixture of the `jensen` Meta with its matching news (the resignation headline and the congress story) and a hot event produces, through a fake Brain returning a canned answer, 3 stored ideas with a "real person" risk label and evidence links to the Meta's top tokens and the news; none of them is a copy of an existing `jensen` token name (tested).
- [ ] **Sorting and counts.** The Proposals list "Score" sort puts `meme` Proposals after scored ones, newest first, tested; counts in the War Room header and the Brain/Study panel include the new task.
- [ ] **War Room shows it.** The list, the filter, the `/meta` ideas and the Proposal page render the fields; `javascript:` URLs and markup in any field are not rendered as links or markup (render tests beside `apps/warroom/server/test`). **Browser check** in the Argus Chrome profile (`~/.local/share/argus/chrome`, never the user's own), at 1240 px and phone width, from a dev server on a seeded DB copy containing at least two `meme` Proposals: screenshot paths in Comments.
- [ ] **Switch.** With `ARGUS_MEME_IDEAS` off nothing is called and nothing is stored; on, the pass runs (tested with a counting fake).
- [ ] **Pipeline docs.** `packages/core/src/pipeline-graph.ts` and `pnpm docs:graph` show the new node and edge (warroom-redesign/10's sync test passes); `docs/architecture.md` agrees with ADR (ticket 05).
- [ ] Full `pnpm check` passes once before each commit.

## Interplay

- **03** (Hot now) provides the trigger and the stored event; **05** the ADR and GLOSSARY; **04** the legitimacy rule. **07** (outcome tracking) reads the stored `meta_snapshot` and the idea rows and follows this ticket.
- **viral-sources/04** slices 3 and 4 are superseded by 05 and 06; its backtest re-run on 2026-11-18 still runs and its result is an input to whether the switch is turned on. Slices 1, 2 and 5 are reused as above.
- **viral-sources/01** (launchpad clustering) is independent; once it ships a Meta may have a matching Narrative, which this ticket does not need.
- **Hardening 06 (egress):** no new host; DexScreener through the declared client.
- Develop in a worktree; never open the live DB; any run you start keeps the switch off.

## Commits

One commit per slice (store and task, then War Room), each after a full `pnpm check`. Subject `Missed ideas ticket 06: <slice and what changed>`, body ending with `Ticket: .scratch/missed-ideas/issues/06-meta-meme-idea-generation.md` before the trailers. Tick a slice's boxes in its commit only if the full check does not stamp the tree afterwards, otherwise in a follow-up docs commit. No `Closes #N`: this repo has no GitHub issues.

## Comments
