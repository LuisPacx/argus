# 21: "Why this Proposal" panel on the Proposal page
**Model:** sonnet / medium — one API field, one view-model util, one component.

**What to build:** Recommendation B of `.scratch/phase-3-feedback/research/proposal-quality-2026-11-11.md`. The rationale is stored but scattered: the Signals live only on `narratives/[id].vue`, the Score and judge rationale sit in the sidebar, and ticket 17 adds `proposals.reason` and `proposals.interaction`, which nothing shows. The Proposal page gets one panel, "Why this Proposal", showing together:
- the propose `reason` and `interaction`;
- the Narrative's top Signals (title, source, link), newest first, at most 5;
- the judge's per-dimension scores, rationale and Rubric version (moved out of the sidebar into the panel);
- the evidence links.

`GET /api/proposals/:id` gains `signals` (top 5 Signals of the Proposal's Narrative: `title`, `sourceLabel`, `url`, `publishedAt`; `[]` for a hand-entered Proposal). Old Proposals have `reason`/`interaction` `""`: the panel shows them as absent ("Not recorded for this Proposal"), never as a blank. `reason`, `interaction`, the rationale and Signal text are untrusted model or source output: rendered as text only (no `v-html`). Links render only for absolute http(s) URLs through `safeHttpUrl` (`apps/warroom/app/utils/safe-link.ts`; the War Room had no safe-link helper before, `UrlLink` printed any href); any other URL is shown as plain text.

**Blocked by:** 17 (branch `proposal-tech-value`: adds `reason` and `interaction`)

**Status:** ready-for-agent

- [ ] `GET /api/proposals/:id` returns `signals` (max 5, newest first, with title, sourceLabel, url, publishedAt), `[]` for a Proposal with no Narrative (tested)
- [ ] The panel shows reason, interaction, Signals, per-dimension scores with rationale and Rubric version, and evidence; absent `reason`/`interaction` ("") show a "not recorded" note, not a blank (tested)
- [ ] A `<script>` in reason, interaction, rationale or a Signal title renders escaped, with no `v-html` in the panel (tested by rendering the component)
- [ ] Only http(s) links become anchors; `javascript:`, `data:` and malformed URLs render as text (tested)
- [ ] Full test suite and type-check pass once before the commit
