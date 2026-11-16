# Argus

Argus turns observed public signals into proposed tokens and their products, and lets one human decide which ones get built and launched. This glossary defines the terms the system and its people use.

## Observation

**Signal**:
A single raw item observed from a Source, such as a post, an article, a trending term, or a launchpad event. Signals are evidence and are never shown as ideas on their own.

**Source**:
A place Signals are observed from, such as a news feed, a social account or search, a trends feed, or a launchpad feed. Every Source has a Source class.

**Source class**:
Whether a Source is `market` or `context`. A market Source (PumpPortal, DexScreener) observes the token market itself; a context Source (news feeds, Google Trends, GitHub trending) observes the world. Only a `news` Narrative that holds at least one market Signal and at least one non-market Signal (a headline) is judged and proposed; a market Signal alone never makes one eligible. context Signals are background for the agents. A Source that is not declared is `context`; a new Source must be declared `market` on purpose. See ADR 0011.
_Avoid_: category

**Narrative**:
A cluster of recent Signals that share a subject and show momentum. The unit the research step produces. It has a kind: `news` (founded by a news Signal, which a DexScreener token may later join but never founds; judged, and proposed from as a Tech Proposal when it passes the buildability gate, or as a Meme Proposal when it fails the gate and passes the floors, ADR 0013) or `launchpad` (one token's creates from the launchpad stream, or DexScreener tokens of the same name that match no news Narrative; context and routing only, never judged or proposed, ADR 0013).
_Avoid_: Trend, topic

## Ideas

**Tech**:
The new technology (product) that could be built to ride a Narrative. For example, the "tokenized stocks" Narrative yields the Tech "a launchpad that pairs each token with a stock". A Tech is a concept until a Build exists.

**Proposal**:
A Narrative paired with a Tech and a token angle (name, ticker, pitch), or, for a `meme` Proposal, a Meta (or a news story that failed the buildability gate) paired with a token idea. It has a kind, `narrative` or `meme` (ADR 0013); older Proposals are `narrative`, and a `narrative` Proposal comes only from a `news` Narrative. It is the unit shown in the War Room and decided on by the Operator, and a `narrative` Proposal carries a Spec once one is drafted.
_Avoid_: Idea (as a bare noun for a Proposal), candidate

**Meme Proposal**:
A Proposal of kind `meme`: a token idea that rides a live Meta (made when a subject becomes a Meta and again every 12 hours while it stays one), generated from the Meta, or, as its one other source, a token idea that rides a news story: a `news` Narrative that failed the buildability gate (so it has no Tech) but passes the legitimacy, hook and momentum floors, one trio per Narrative ever (it links the Narrative and the Score it failed with, and a later Tech Proposal for the same Narrative is still possible). It has a name, ticker, angle, how it differs from the Meta's leader (name copies are rejected), a short description, an X first-post hook, an image idea as text, risk labels and evidence links. It has no Tech, no Spec, no Build and no Rubric score of its own; the Operator can shortlist it or dismiss it with a reason, and it expires after 12 hours in new (the refresh interval; it was 6) unless shortlisted. Legitimacy follows the Rubric (impersonation, fraud, and hate or harassment; satire is not penalised). See ADR 0013.
_Avoid_: Beta Proposal (the kind that was planned under that name is `meme`)

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
The editable dimensions (momentum, novelty, buildability, hook, legitimacy) by which a Narrative is scored before it becomes a Proposal; buildability is a hard gate. Owned by the Operator. From Rubric v3, legitimacy penalises impersonation (pretending to be a real person, brand or project, claiming to be official, fake endorsements) and fraud (a false claim meant to take money) only; satire, parody and memes about public figures are not penalised.

**Score**:
A Narrative's Rubric result (a Proposal's card shows the Score it was created from and, when the Narrative has been judged again since, the latest as "now"), re-computed when the Narrative changes materially; each is stored with the Rubric version it used, and its history is kept.

## Market

**Meta**:
A current trend with a token really high: a token of any age at millions of market cap (the NVIDIA CEO case), with several copies riding it, lasting minutes to days. Argus finds it top-down (ADR 0015): the leader is a token on Jupiter's or GeckoTerminal's trending list that passes a fake-token filter and whose market cap DexScreener confirms, and an AI step names the subject and groups launch themes with different names or tickers on one story (Lucia, Vice City and GTA VI are one Meta; when the step is off or over its cap, rules name it by what the most distinct creators used and merge spelling aliases). The rule itself is plain code on market cap (ADR 0014): a subject becomes a Meta when its leader token reaches $1,000,000 and at least 10 distinct creators launched copies (pump.fun or bonk) in the last 24 h, stays one while the leader holds $500,000 (copies are not needed to stay), and at most 3 Metas exist at once; "No Meta right now" is a normal state. A Meta is observed on the market, whereas a Narrative is argus's own cluster of Signals from Sources, and a Proposal is argus's pairing of a Narrative with a Tech. A Narrative may match a Meta, but the two are not the same thing.
_Avoid_: Trend (reserved against Narrative), Narrative (when meaning a Meta), "Meta" for a launch theme that has no high token (that is a launch theme, see below)

**Watching**:
A subject that is not a Meta yet: the top 3 other subjects by leader market cap that are below $1,000,000 and meet the copies rule (10 distinct creators in 24 h, pump.fun and bonk launches). A Meta that falls below $500,000 competes for Watching like any subject. Labelled "Watching" everywhere, never shown as a Meta.

**Launch-theme list** (formerly **Meta ranking**; "All launch themes" on the page, counts only):
The worker's periodic list of launch themes, grouped and ranked from launchpad tokens by plain code. It is context for a Meta (its counts, its copies), no longer the definition of one: it ranks by distinct creators first, so a theme with many copies and no high token is on it and is not a Meta. Order: distinct creators first, then migrations more than 60 s after the create, market cap, then token count, for the last 6 h and 24 h. A group is on the list in a window only with at least 5 tokens from at least 3 distinct creators in that window (the size floor; one creator's 34 tokens are not a theme). When a window's hours are thinly covered by ingested creates (after a pause), the War Room says "Only 1 h of data in the last 24 h" and the judge and propose prompts carry no launch-theme block. Migrations are unfiltered until the bot filter exists. Small clusters that name a big theme's subject (`Ni Hao Noon`, `GTA 6 Cat`) join it as one launch theme. A launch theme shows its counts and a templated numbers line only: no model summary and no meme ideas (those belong to the Metas and the Watching subjects, at most 6, and the judge and propose prompts carry those too, each with its leader token and cap). A launch theme is context, not a Narrative and not a Proposal, and not a Meta unless a high token leads it. Several launch themes can sit under one Meta's name (ADR 0015); the list itself is unchanged and counts pump.fun launches only, whereas a Meta's own copier count includes bonk launches. A theme's key and label are the ones used by the most distinct creators, so one creator minting 44 tokens does not name it.

**New Meta**:
The moment a subject becomes a Meta: it is a Meta in this Meta run and was not in the run before. Stored as an event (a subject that falls out and comes back is new again), shown in the War Room on home and `/meta` for 6 hours while it is still a Meta, with its leader token, summary and the matching news, and it starts a meme ideas run (ADR 0013). After a restart, a pause, or on the first run only the baseline is set: nothing is raised. News is context beside it and never raises it.
_Avoid_: Hot now (the old trigger, replaced by New Meta: ADR 0014 and meta-redesign ticket 03), alert (it only appears in the War Room; nothing is sent)

**Beta**:
A token whose narrative resembles that of a Meta token already running high, riding the demand of people looking for something similar to it. A Beta belongs to the same Meta, or to one close to it. Argus proposes one as a Meme Proposal.

**Vamping**:
Launching a token to take the volume of a token that is rising in market cap but has a mistake in its ticker, name, links or image, or in the type of token it was created as (for example one that was meant to have fee sharing, holder rewards, or a stock pairing). Unlike a Beta, which imitates a narrative, a vamp targets one specific token's flaw. When the Operator does this it is a Launch.

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
The state of a Proposal, which is one of: new, shortlisted, spec-drafted, approved, building, built, build-failed, needs-human, launched, or closed. A Proposal may enter dismissed from any state except closed. The system sets new (on creation), spec-drafted (after the Operator shortlists; never for a Meme Proposal), and closed on expiry (48 hours in new, counted from creation, 12 hours for a Meme Proposal, and 7 days in shortlisted); the Operator sets shortlisted, new again (an undone shortlist, possible until the Spec is approved; it is not a Dismissal and records no feedback), approved, dismissed, launched, and closed after a Launch; the Build step sets building, built, build-failed (when a Build fails after its retry), and needs-human (when a Spec requires something that cannot be built unattended, such as an on-chain program).

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
