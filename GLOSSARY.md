# Argus

Argus turns observed public signals into proposed tokens and their products, and lets one human decide which ones get built and launched. This glossary defines the terms the system and its people use.

## Observation

**Signal**:
A single raw item observed from a Source, such as a post, an article, a trending term, or a launchpad event. Signals are evidence and are never shown as ideas on their own.

**Source**:
A place Signals are observed from, such as a news feed, a social account or search, a trends feed, or a launchpad feed.

**Narrative**:
A cluster of recent Signals that share a subject and show momentum. The unit the research step produces.
_Avoid_: Trend, topic

## Ideas

**Tech**:
The new technology (product) that could be built to ride a Narrative. For example, the "tokenized stocks" Narrative yields the Tech "a launchpad that pairs each token with a stock". A Tech is a concept until a Build exists.

**Proposal**:
A Narrative paired with a Tech and a token angle (name, ticker, pitch). It is the unit shown in the War Room and decided on by the Operator, and it carries a Spec once one is drafted.
_Avoid_: Idea, candidate

**Spec**:
The written description of a Tech from which a Build is produced. It is drafted by the system, refined by the Operator, and is the artifact of the decision to build.

**Build**:
The software project produced from an approved Proposal's Spec. It is a narrow, working MVP produced unattended within hours.

**Build container**:
The isolated environment in which a Build's agent and the code it produces run, with no access to the Operator's credentials or files and no network beyond an allowlist.
_Avoid_: Sandbox, VM

**Launch**:
The on-chain token created for a Proposal. Launches happen outside this system, by the Operator.
_Avoid_: Deploy, mint

**Rubric**:
The editable dimensions (momentum, novelty, buildability, hook, legitimacy) by which a Narrative is scored before it becomes a Proposal; buildability is a hard gate. Owned by the Operator.

**Score**:
A Narrative's Rubric result (a Proposal carries its Narrative's latest), re-computed when the Narrative changes materially; each is stored with the Rubric version it used, and its history is kept.

## People

**Operator**:
The human who decides. The Operator shortlists, approves, dismisses and marks Launches, and also edits the Spec and the Rubric. There is one Operator.

**Team**:
The people the Operator discusses Proposals with. They receive Proposal notifications, and discussion happens outside the system; they never act in it.

## Decision

**War Room**:
The view where the Operator sees all live Proposals with their evidence and status, and acts on them.

**Dismissal**:
The Operator's decision not to pursue a Proposal. Dismissals, like approvals, are recorded as feedback that sharpens future research.

**Proposal status**:
The state of a Proposal, which is one of: new, shortlisted, spec-drafted, approved, building, built, build-failed, needs-human, launched, or closed. A Proposal may enter dismissed from any state except closed. The system sets new (on creation), spec-drafted (after the Operator shortlists), and closed on expiry (48 hours in new, counted from creation, and 7 days in shortlisted); the Operator sets shortlisted, new again (an undone shortlist, possible until the Spec is approved; it is not a Dismissal and records no feedback), approved, dismissed, launched, and closed after a Launch; the Build step sets building, built, build-failed (when a Build fails after its retry), and needs-human (when a Spec requires something that cannot be built unattended, such as an on-chain program).

**Est. usage**:
The API-equivalent dollar figure (`total_cost_usd`) that `claude -p` reports for each run. On the Claude subscription it measures usage against plan limits, not money billed. Per-task caps (`--max-budget-usd`) limit how much usage one run can take.

**API spend**:
Real dollars billed by the Anthropic API when the optional API fallback serves a judge or propose run (the subscription is rate-limited). Computed from the provider's reported token usage times the model's price, held to a daily cap in code, and always shown apart from Est. usage, which is not money.

## Learning

**Study**:
The standing, unattended programme that watches new pump.fun tokens that have a website or X link, records how each looked early, finds out later which ones migrated organically, and learns from the difference. It studies other people's tokens, never argus's own Launches.

**Snapshot**:
The frozen record of one studied token's website, X account, metadata and launch figures, taken once at a fixed early age and never edited, so that later analysis cannot see the outcome. The metadata and website part is taken at 60 seconds after the create, the X part at 5 minutes (capture rule version 1, `packages/core/src/study/config.ts`).

**Case**:
A studied token whose outcome is final, pairing its Snapshot with that outcome. Cases are analysed without the outcome shown, and the outcome is joined afterwards.
_Avoid_: Sample, example

**Cohort**:
The Cases whose tokens were created in the same calendar week of launch. A lesson learned on one Cohort is tested on later ones.

**Playbook**:
The evidence-backed lessons the Study has learned, each suggested until the Operator approves it, plus the Rubric changes it suggests. Approved lessons are shown to the research steps; the Operator reviews the Playbook weekly.
_Avoid_: Insights, model

**Organic migration**:
A token's bonding curve completing and moving to a swap pool, where the buying looks like many independent buyers and not bots or insiders controlling the supply. It is the Study's success label. A migration that fails the bot filter is a bot-driven migration, kept as its own group.
_Avoid_: Graduation, bonding, success

**Fast migration**:
A migration that happens within 60 seconds of the token's creation (event times), the same age as the website Snapshot (the Operator's decision on 2026-11-08, from the first slice's measurement; the earlier 30-minute starting value would have flagged 86% of migrators). Fast migrations are kept and counted, but the Playbook learns no lessons from them.
