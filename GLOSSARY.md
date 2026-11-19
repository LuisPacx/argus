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
_Avoid_: topic; Trend (a Trend is the radar's own find and is not a cluster, see Trend)

## Ideas

**Tech**:
The new technology (product) that could be built to ride a Narrative. For example, the "tokenized stocks" Narrative yields the Tech "a launchpad that pairs each token with a stock". A Tech is a concept until a Build exists.

**Proposal**:
A Narrative paired with a Tech and a token angle (name, ticker, pitch), or, for a `meme` Proposal, a Meta (or a news story that failed the buildability gate) paired with a token idea. It has a kind, `narrative` or `meme` (ADR 0013); older Proposals are `narrative`, and a `narrative` Proposal comes only from a `news` Narrative. It is the unit shown in the War Room and decided on by the Operator, and a `narrative` Proposal carries a Spec once one is drafted.
_Avoid_: Idea (as a bare noun for a Proposal), candidate

**Meme Proposal**:
A Proposal of kind `meme`: a token idea that rides a live Meta (made when a subject becomes a Meta and again every 12 hours while it stays one), generated from the Meta, or, as its one other source, a token idea that rides a news story: a `news` Narrative that failed the buildability gate (so it has no Tech) but passes the legitimacy, hook and momentum floors, one trio per Narrative ever (it links the Narrative and the Score it failed with, and a later Tech Proposal for the same Narrative is still possible). It has a name, ticker, angle, how it differs from the Meta's leader (name copies are rejected), a short description, an X first-post hook, an image idea as text, risk labels and evidence links. It has no Tech, no Spec, no Build and no Rubric score of its own; the Operator can shortlist it or dismiss it with a reason, and it expires after 12 hours the worker is running in new (the refresh interval; it was 6; time the worker was stopped does not count, with no cap) unless shortlisted. Legitimacy follows the Rubric (impersonation, fraud, and hate or harassment; satire is not penalised). A third source of meme ideas is the Operator's own angle on a current Meta (an **Operator angle**, below): the worker runs the same pass for it and files three ordinary meme Proposals that show the angle. A fourth source is a Moment (below): when the Operator presses "Make ideas" on one, the worker runs the same pass with the Moment's post and counts in place of a Meta and files three ordinary meme Proposals that show it. A fifth source is a Trend (below): the same press, with the Trend's subject, sources and coin-side picture in place of a Meta (ADR 0016). See ADR 0013.
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

**Verdict**:
The Operator's call on a Narrative in the War Room: good or bad, with optional reason tags (wrong cluster, duplicate, score too high or low, the last two with the Rubric dimensions he thinks were off) and a short note. Kept as history (the newest is the current one), each stored with the Score and Rubric version that were the Narrative's latest when it was made (none for a Narrative that was never scored), and used only to calibrate the judge by hand: nothing reads it back automatically.

## Market

**Meta**:
A current trend with a token really high: a token of any age at millions of market cap (the NVIDIA CEO case), with several copies riding it, lasting minutes to days. Argus finds it top-down (ADR 0015): the leader is a token on Jupiter's or GeckoTerminal's trending list that passes a fake-token filter and whose market cap DexScreener confirms, and an AI step names the subject and groups launch themes with different names or tickers on one story (Lucia, Vice City and GTA VI are one Meta; when the step is off or over its cap, rules name it by what the most distinct creators used and merge spelling aliases). The rule itself is plain code on market cap (ADR 0014): a subject becomes a Meta when its leader token reaches $1,000,000 and at least 10 distinct creators launched copies (pump.fun or bonk) in the last 24 h, stays one while the leader holds $500,000 (copies are not needed to stay), and at most 3 Metas exist at once; "No Meta right now" is a normal state. A Meta is observed on the market, whereas a Narrative is argus's own cluster of Signals from Sources, and a Proposal is argus's pairing of a Narrative with a Tech. A Narrative may match a Meta, but the two are not the same thing.
_Avoid_: Trend (a Trend is the radar's find and may have no token at all; a Meta always has a high token), Narrative (when meaning a Meta), "Meta" for a launch theme that has no high token (that is a launch theme, see below)

**Watching**:
A subject that is not a Meta yet: the top 3 other subjects by leader market cap that are below $1,000,000 and meet the copies rule (10 distinct creators in 24 h, pump.fun and bonk launches). A Meta that falls below $500,000 competes for Watching like any subject. Labelled "Watching" everywhere, never shown as a Meta.

**Launch-theme list** (formerly **Meta ranking**; "All launch themes" on the page, counts only):
The worker's periodic list of launch themes, grouped and ranked from launchpad tokens by plain code. It is context for a Meta (its counts, its copies), no longer the definition of one: it ranks by distinct creators first, so a theme with many copies and no high token is on it and is not a Meta. Order: distinct creators first, then migrations more than 60 s after the create, market cap, then token count, for the last 6 h and 24 h. A group is on the list in a window only with at least 5 tokens from at least 3 distinct creators in that window (the size floor; one creator's 34 tokens are not a theme). When a window's hours are thinly covered by ingested creates (after a pause), the War Room says "Only 1 h of data in the last 24 h" and the judge and propose prompts carry no launch-theme block. Migrations are unfiltered until the bot filter exists. Small clusters that name a big theme's subject (`Ni Hao Noon`, `GTA 6 Cat`) join it as one launch theme. A launch theme shows its counts and a templated numbers line only: no model summary and no meme ideas (those belong to the Metas and the Watching subjects, at most 6, and the judge and propose prompts carry those too, each with its leader token and cap). A launch theme is context, not a Narrative and not a Proposal, and not a Meta unless a high token leads it. Several launch themes can sit under one Meta's name (ADR 0015); the list itself is unchanged and counts pump.fun launches only, whereas a Meta's own copier count includes bonk launches. A theme's key and label are the ones used by the most distinct creators, so one creator minting 44 tokens does not name it.

**Operator angle**:
A story or joke the Operator types on the Meta page for a current Meta or a Watching subject (for example a screenshot caption with its link), with one button. The War Room stores it as a request row and nothing else; the worker runs the `meme-ideas` path with the angle as a fenced, untrusted block of the prompt and files three meme Proposals about it (the first link is split out by code and shown on the Proposal page only if it is a plain http or https address). It counts as a meme-ideas run in the daily meme cap and the research budget, at most 5 requests in 24 hours, one waiting at a time. argus still only writes text for the Operator (ADR 0002).
_Avoid_: Prompt (the Operator does not write the prompt), custom idea

**New Meta**:
The moment a subject becomes a Meta: it is a Meta in this Meta run and was not in the run before. Stored as an event (a subject that falls out and comes back is new again), shown in the War Room on home and `/meta` for 6 hours while it is still a Meta, with its leader token, summary and the matching news, and it starts a meme ideas run (ADR 0013). After a restart, a pause, or on the first run only the baseline is set: nothing is raised. News is context beside it and never raises it.
_Avoid_: Hot now (the old trigger, replaced by New Meta: ADR 0014 and meta-redesign ticket 03), alert (it only appears in the War Room; nothing is sent)

**Beta**:
A token whose narrative resembles that of a Meta token already running high, riding the demand of people looking for something similar to it. A Beta belongs to the same Meta, or to one close to it. Argus proposes one as a Meme Proposal.

**Vamping**:
Launching a token to take the volume of a token that is rising in market cap but has a mistake in its ticker, name, links or image, or in the type of token it was created as (for example one that was meant to have fee sharing, holder rewards, or a stock pairing). Unlike a Beta, which imitates a narrative, a vamp targets one specific token's flaw. When the Operator does this it is a Launch.

**Moment**:
One concrete thing that happened inside a Watched topic and is spreading on X (a gameplay clip, an easter egg, a character, an in-game object), found by plain counting on posts, usually before any token for it exists. It has a tier (`rising`, `qualifying`, `cooling`), a best post with its views, likes and views an hour, a kind and plain subject written by a model (a `moment` or `reaction`; news, opinion and brand posts are not Moments), and a coin-side state from DexScreener: `open` (no real clone), `contested` (real clones under $50,000) or `taken` (a real clone at $50,000 or more). A real clone has at least $5,000 of liquidity and a market cap of at most 100 times it; a pair that fails (a drained pool, a fake cap) is a lookalike, shown but not counted. A Moment is led by attention on X, a Meta by a token's market cap; it can sit under a Meta. It is not a Signal, a Source or a Narrative (ADR 0009, ADR 0011): it never starts a Proposal by itself, only when the Operator asks for ideas, which are ordinary meme Proposals (ADR 0013). Shown on the War Room's Moments page. See `.scratch/moment-scanner/spec.md`.
_Avoid_: Trend (a Trend is a subject found by the radar, a Moment is one clip inside a subject), alert, Narrative (a Moment is not clustered or judged by the Rubric)

**Watched topic**:
A subject the moment scanner searches X for: a label, its search spellings (the plain variants "GTA VI", "GTA 6", "GTA6", "#GTA6") and a start time before which posts are ignored. It comes from a current Meta or Watching subject, from the Operator, or from a Trend (the Operator presses Watch on X; in stage B of the radar, automatically, in at most 2 of the 4 slots). Not a Narrative and not a Meta.

**Trend**:
A subject (a plain, nameable thing: a release, an event, a character, a person, a phrase) that one or more outside places show as new and rising, found by the trend radar by plain counting, usually before any token for it exists. Sources: Google Trends' rising terms in several countries and a radar-only list of news feeds (stage A, free), and X's official trend counts (stage B, paid under a cap in code). It is stored with its plain subject and search phrases (written by a model, checked by code), the sources that carried it and when, a score from plain code, and a coin-side picture (DexScreener's live tokens by the live-token test, and the pump.fun creates argus has seen under that name). It is not a Signal (the radar's readings go in its own tables, never `signals`), not a Narrative (not clustered, no Rubric, never judged, never a Tech Proposal), not a Meta (a subject that is a Meta or Watching is dropped as already tokenized) and not a Moment (a Moment is one clip inside a subject; a Trend can become a Watched topic and then holds Moments). It never starts a Proposal by itself: only when the Operator presses "Make ideas", which files ordinary meme Proposals with a trend source (ADR 0016). Shown on the War Room's Radar page. See `.scratch/trend-radar/spec.md`.
_Avoid_: Narrative, Meta, Moment (when meaning a Trend), Signal, hot topic

**Untokenized**:
A state of a Trend: no live token on Solana matches its phrases (by `packages/core/src/meme/live-token.ts`: priced, liquidity of at least $5,000, market cap at most 100 times liquidity) and at most 4 distinct creators among the pump.fun creates of the last 48 hours that match its name. Local creates are a partial view (PumpPortal misses about 47 percent of creates), so the DexScreener answer carries the check. A Trend whose coin-side check failed is `not traced`, never untokenized. The other states are `contested` (live tokens under $50,000), `taken` (a live token at $50,000 or more) and `tokenizing` (5 or more distinct local creators, so the market is already moving on it).
_Avoid_: new, unlaunched, open (open is the Moment's coin-side state, from which this one reuses the rule, and means only the DexScreener half)

**Radar**:
The worker job and the War Room page (`/radar`) that find and list Trends. It runs 24/7 under caps in code, makes no Signals and starts no Judge or Propose run; its one model task (`radar-name`, haiku) names and filters candidates that counting found.

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
The state of a Proposal, which is one of: new, shortlisted, spec-drafted, approved, building, built, build-failed, needs-human, launched, or closed. A Proposal may enter dismissed from any state except closed. The system sets new (on creation), spec-drafted (after the Operator shortlists; never for a Meme Proposal), and closed on expiry (48 hours in new, counted from creation, 12 hours the worker is running for a Meme Proposal (recorded downtime does not count), and 7 days in shortlisted); the Operator sets shortlisted, new again (an undone shortlist, possible until the Spec is approved; it is not a Dismissal and records no feedback), approved, dismissed, launched, and closed after a Launch; the Build step sets building, built, build-failed (when a Build fails after its retry), and needs-human (when a Spec requires something that cannot be built unattended, such as an on-chain program).

**Est. usage**:
The API-equivalent dollar figure (`total_cost_usd`) that `claude -p` reports for each run. On the Claude subscription it measures usage against plan limits, not money billed. Per-task caps (`--max-budget-usd`) limit how much usage one run can take. A run that is killed or crashes prints no figure, so its cost is **estimated** (the priced usage it streamed, its run time at the recent Builds' average rate, or its route's cap) and the War Room marks it "est."; one that nothing recovered and nothing charges shows as **unknown**; what claude itself reported is **exact**.

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
