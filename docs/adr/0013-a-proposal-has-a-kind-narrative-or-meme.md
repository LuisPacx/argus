# A Proposal has a kind: `narrative` or `meme`

Status: accepted (missed ideas ticket 05, 2026-11-15; decided by the Operator on 2026-11-14, missed-ideas/01 answers Q5, Q9, Q10, Q11, Q12 and Q14).

Until now every Proposal pairs a Narrative with a Tech (GLOSSARY: Proposal), is scored against the Rubric with buildability as a hard gate, gets a Spec when shortlisted and is built. That path cannot surface a joke token about a live story: the Nvidia CEO case was lost because the Narrative was scored down for legitimacy and there is no Tech worth building for a meme. A Proposal now has a **kind**: `narrative` (today's) or `meme`.

A `meme` Proposal is an idea for a token that rides a live Meta (GLOSSARY: Meme Proposal). It is generated from a Meta that is Hot now (missed-ideas/03), not from a Narrative, and has no Tech.

Decisions:

- **`proposals.kind`** is a column with the values `narrative` and `meme`. Every existing Proposal reads `narrative`. The column, its idempotent migration, the task, the cap and the UI are built by missed-ideas/06; this ADR is the contract it builds against.
- **A `meme` Proposal pairs a Meta with an idea.** It stores the Meta's label and an immutable snapshot of the Meta as it was at generation (counts, top tokens, matching news), so the card stays readable after the Meta moves. It has no Narrative and no Tech. A Meta stays context (ADR 0012): the Proposal cites a Meta, it does not turn the Meta into a Narrative or a Score.
- **Fields (Q14):** name, ticker, angle (the joke and why now), how it differs from the leader (name copies are rejected; the distinct-name rule of `packages/core/src/beta/` is the check), a short description, an X first-post hook, an image idea as text, risk labels (for example "real person") and evidence links (the Meta's top tokens and the matching news). No image or logo is generated.
- **Generation (Q10):** only on the Hot now trigger, at most once per Meta per 6 h, one sonnet run that produces 3 ideas, with its own cap of 40 runs a day taken from the research budget (the judge plus propose share, architecture section 5), not added to it. The room-left ranking from viral-sources/04 slices 1 and 2 is an input to the prompt.
- **Legitimacy comes from Rubric v3 (missed-ideas/04) and nowhere else.** Memes and satire about public figures are allowed; impersonation and fraud are not. The risk labels are how a `meme` Proposal says "real person" without scoring itself; the prompt reuses the v3 wording, so the Rubric stays the single source and the meme task keeps no second copy of the rule.
- **Lifecycle (Q9):** Shortlist, Dismiss with a reason, and Why. **No Spec, no Build and no Rubric score of its own**; the buildability gate does not apply, because there is nothing to build. A `meme` Proposal in `new` expires after **6 h** (counted from creation, as `new` already is) unless it is shortlisted; a shortlisted one follows the existing 7 days. It shows as a list filter on Proposals and under each Meta on `/meta`. Telegram notification is not part of this decision.
- **Outcome tracking (Q12, missed-ideas/07):** the Meta's stats at creation, the outcome at +6 h and +24 h (migrations after 60 s, top market cap), later launches that match the name or ticker and how they did, and a weekly review of the hit rate against the 1.3% base rate. The kind is measured from the start.

What it replaces:

- **The planned `beta` kind** (viral-sources/04 slices 3 and 4: the Beta proposal task and its War Room). They are superseded and never built. The backtest of viral-sources/04 had already shown no lift (the switch `ARGUS_BETA_PROPOSALS` stayed off); the 2026-11-18 re-run still runs and its result feeds missed-ideas/06. The room-left ranking and the distinct-name rule (slices 1 and 2) stay, as inputs. The GLOSSARY term Beta stays as the name of the launch idea; a Beta is proposed as a `meme` Proposal, and no "Beta Proposal" entry is added.
- **The Operator's decision of 2026-11-11** that a `meme` kind waits (Phase 4) until one tag lesson has replicated on a later Cohort. Q5 (2026-11-14) supersedes it: meme ideas start now, with no Spec and no Build, and are measured from the first one instead of gated on a lesson.

What it contradicts:

- **The GLOSSARY definition of Proposal** ("a Narrative paired with a Tech and a token angle"), which is amended to cover the second kind, and the "Proposal status" expiry rule (48 hours in `new`), which gains the 6 h `meme` exception. Anything that assumed every Proposal has a Narrative, a Tech, a Score and a Spec must read `kind` first.

What it leaves alone:

- **ADR 0002:** argus never launches, signs or spends. A `meme` idea is text for the Operator to act on outside the system; the image idea is text and no image is made.
- **ADR 0011:** eligibility of a Narrative is unchanged. A `meme` Proposal is not eligibility-gated by a market Signal of a Narrative; its market evidence is the Meta's own launchpad data, which is market class. News stays context and never raises the trigger.
- **ADR 0012:** a Meta is ranked by plain code and stays context. The Hot now event (its addendum) is the trigger; the summary path and the prompt blocks are unchanged.
- ADR 0003 (one build archetype) is untouched: a `meme` Proposal never reaches the Build.
