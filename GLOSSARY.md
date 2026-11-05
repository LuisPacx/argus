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

**Launch**:
The on-chain token created for a Proposal. Launches happen outside this system, by the Operator.
_Avoid_: Deploy, mint

**Rubric**:
The editable dimensions (momentum, novelty, buildability, hook, legitimacy) by which a Narrative is scored before it becomes a Proposal; buildability is a hard gate. Owned by the Operator.

**Score**:
A Proposal's current Rubric result, re-computed when new Signals arrive; its history is kept.

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
The state of a Proposal, which is one of: new, shortlisted, spec-drafted, approved, building, built, build-failed, needs-human, launched, or closed. A Proposal may enter dismissed from any state except closed. The system sets new, spec-drafted (after the Operator shortlists), and closed on expiry (48 hours in new, 7 days in shortlisted); the Operator sets shortlisted, approved, dismissed, launched, and closed after a Launch; the Build step sets building, built, build-failed (when a Build fails after its retry), and needs-human (when a Spec requires something that cannot be built unattended, such as an on-chain program).

**Est. usage**:
The API-equivalent dollar figure (`total_cost_usd`) that `claude -p` reports for each run. On the Claude subscription it measures usage against plan limits, not money billed. Per-task caps (`--max-budget-usd`) limit how much usage one run can take.
