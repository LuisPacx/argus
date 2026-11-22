# Subjects are stabilised across runs, and blend names join them

Status: accepted (decided by the Operator, 2026-11-22; `.scratch/christmas-fix/`, tickets 01 to 05). Amends ADR 0018 item 2 (how a graduate joins a subject). Keeps the grouping step of ADR 0015.

The Christmas wave of November 2026 still failed to become one Meta under ADR 0018. The AI names and groups afresh every 15-minute run, so the subject flipped between Christmas and Santa and lost its state, and graduates such as Bullmas, CATEMAS and pepesanta carried no name or ticker form that matched the subject exactly, so they never counted.

## Decision

1. **Subject stabiliser.** Plain code between the grouping answer and `applyGrouping` (`meta/stabilise.ts`): a subject whose member themes overlap a subject of the previous run takes that subject's key, so its state (`enteredAt`, holding, leader) carries. A previous subject nothing matched is kept while it is inside the state window, now 120 minutes (`ARGUS_META_STATE_MAX_MINUTES`). The themes of every previous subject are always sent to the AI, even below the 30-theme cut. The AI's answer is never changed. The rules fallback is stabilised the same way.
2. **One shared term module.** NFKC normalisation and term matching live in one module (`term-match.ts`) used by grouping, graduate assignment and research, so every path reads a name the same way.
3. **Blend pass** (`meta/blend.ts`, run in `assignGraduates` after the two exact passes; amends ADR 0018 item 2). A graduate still unassigned joins a subject when it carries one of the subject's terms: the subject's key, label and merged launch-theme keys (3 characters or more, never a generic key), and learned stems from its own tokens' names and tickers. Defaults:
   - a learned stem is 4 characters or more;
   - it must be used by at least 3 distinct creators among the subject's tokens;
   - at least 70% of all tokens carrying it, across every subject, belong to this subject (self-consistency);
   - a graduate that matches more than one subject is ambiguous and goes to none;
   - nothing moves out of an AI-named subject or out of an earlier pass: only still-unassigned graduates are placed;
   - weak subjects only: a subject already a Meta (over the bar, or one the previous run had that hysteresis keeps) gains nothing, so the pass lifts a weak subject over the bar and never pads a strong one;
   - blended graduates count in the 24 h, 6 h and distinct-creator totals like any other;
   - no prompt hints: the model is never told the terms or the stems;
   - no AI-seeded terms: model output never adds a term, so an injected name cannot steer who joins a Meta.
4. **Operator-visible.** The Meta page shows "includes N graduates matched by name blend" for a subject with blended graduates: a count only, never model or token text. The count is stored with the subject's graduation numbers (`grads.blended`, in the existing JSON; no schema change).

Plain code decides Metas (ADR 0012); the blend pass is deterministic code over untrusted text, and the model still only names and summarises. Nothing launches or signs (ADR 0002). No new schedule and no schema change.

## What stays valid

ADR 0018 items 1 and 3 to 9, and ADR 0015's AI grouping step and its fallback to rules.

## Considered options

- **Ask the AI to place the stragglers.** Rejected: it adds a model decision to what counts as a Meta (ADR 0012) and is not stable between runs.
- **Match any substring of the subject name.** Rejected: "Thomas" would join a "mas" subject; the 3-creator and 70% rules and the ambiguity rule keep a stem honest.

## Consequences

- A wave whose tokens each spell the narrative differently still reaches one Meta, and keeps its entry time while the AI renames it.
- A stem pushed by a few wallets is blocked by the 3-creator rule; a very common word is blocked by the 70% rule.
