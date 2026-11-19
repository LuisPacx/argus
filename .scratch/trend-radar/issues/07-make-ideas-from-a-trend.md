# 07: "Make ideas" from a Trend through the meme-ideas path
**Model:** sonnet / high. The first path where a button on third-party feed text starts a paid run, filed as ordinary Proposals. It touches the trust boundary, the caps, the snapshot contract and the rule that the War Room never writes Proposal state. Precedent: Meta redesign ticket 11 (Operator angle) and moment scanner ticket 06, whose designs this reuses almost line for line.

**What to build:** on each named Trend of `/radar`, a **Make ideas** button. It writes one request row. The worker runs the existing `meme-ideas` path with the Trend (plain subject, phrases, sources and numbers, flags, coin-side state) in place of a Meta block, and files three ordinary `meme` Proposals with a trend source. Each Proposal shows where it came from. Useful alone: the Operator goes from a subject found before any coin to three named ideas in one press, with the names already checked against the clones the check found.

**Status:** ready-for-agent

**Blocked by:** 04
It needs the model's plain subject, phrases and flags. Spec: section 6.3. ADR 0016 decision 2 and the ADR 0013 amendment of this feature. Moment scanner ticket 06 (not built) is independent; whichever lands first, snapshot version 4 is the Moment's and version 5 is the Trend's.

## Design

- **Request.** `POST /api/radar/ideas` `{ trendId }` writes one request row (insert only; body handling as `meme-angle.post.ts`) and nothing else. A Trend not yet named, `ignored`, or no longer live is refused with the reason before any model call.
- **Run.** The worker claims the row and runs `meme-ideas` with a Trend block in place of the Meta block: plain subject, phrases (offered as the plain names the naming rules ask for), sources with their times and numbers, flags, the traced clones and lookalikes. The Trend's text is third-party: it goes in as one fenced block under a fresh random boundary, flattened and cut, named untrusted; the instruction that the ideas are about the Trend is outside the fence; the output, risk-label and name rules are not the Operator's or the Trend's to change. Same parser, same repair retry and live-token copy check (ticket 16's `isLiveToken`), same legitimacy text from the stored Rubric, no tools, no API fallback. The `real person` flag makes the risk label required.
- **Store.** Three ordinary `meme` Proposals: `meta_key = trend:<id>`, `meme_window` keyed to the request (as an angle trio, negated request id) so they are neither blocked by a Meta's automatic trio nor blocking it, snapshot version 5 `{ version: 5, kind: "trend", capturedAt, trend, trigger, trace }` (the Trend's subject, key, first flag, score and breakdown, sources with links as they were, flags, coin-side state with the real clones and lookalikes read; links only `http` and `https` through `safeHttpUrl`), trigger `trend-operator` with the time. Versions 1 to 4 stay readable; readers branch on `version`. Evidence links are the Trend's source links and DexScreener pair links.
- **Names to avoid:** the traced clones and lookalikes' names and tickers, and a current Meta's tokens when the Trend's subject sits under one.
- **Caps.** Counts in the angle allowance (10 in any rolling 24 hours, ceiling 10, counting only runs that file Proposals), in the research budget and in the 30-a-day new Proposals cap, not in the automatic 8-a-day meme cap; at most one waiting; one request for the same Trend in 24 hours (keyed on `trend:<id>`, not on text, since the text carries live numbers); ends `done`, `refused`, `failed` or `capped` with the reason, never left waiting by a cap. A rate limit, a shutdown or a dry run leaves it waiting. No automatic trio from a Trend: nothing in the code starts one without a request row.
- **Proposal page and card** show the source ("From a Trend: <subject>, found <time>, sources, score, coin-side state at creation") and the Trend's source links.

## Acceptance criteria

- [ ] **Request API** (`apps/warroom/server/test/radar-ideas.test.ts`): a good body returns 200 and one pending row; a Trend not yet named, ignored or no longer live is refused with its reason and no row; wrong types, extra keys, an unknown Trend, non-JSON or oversized bodies are 400 with nothing stored; a second request for the same Trend inside 24 hours is refused (409); the War Room writes no Proposal and no other table; a GET leaves every table unchanged.
- [ ] **Worker and prompt** (`radar-ideas.test.ts`, fake Brain): the run uses the `meme-ideas` task (no new task or route); the Trend block is fenced under a fresh boundary, flattened and cut, a hostile subject, forged boundary line and 100,000 characters of source text cannot end the block or add an instruction; the names to avoid include the clones and lookalikes; a copied live-token name is refused once with the names listed and a dead or drained token's name is stored with its note (ticket 16's rules, unchanged); a contract error gets one repair retry; a `real person` flag makes the risk label required.
- [ ] **Store** (`store.test.ts`): three `meme` Proposals with `meta_key = trend:<id>`, snapshot version 5 and trigger `trend-operator`; the Trend's links are kept only if `http` or `https`; versions 1 to 4 snapshots still read; the trio does not block a Meta's automatic trio and is not blocked by it; 12-hour life and Shortlist or Dismiss work as for any meme idea (existing lifecycle tests unchanged).
- [ ] **Caps** (`radar-ideas-caps.test.ts`): runs count in the angle allowance only when they file Proposals; the 3x hard cap holds across retries and refusals; the research budget refuses and the request ends `capped`; the 8-a-day meme cap is not touched; a Trend that stopped being live while waiting ends `refused` ("no longer live") with no model call; a rate limit leaves it waiting.
- [ ] **Render** (`radar-render.test.ts` and the Proposal page tests, `pnpm page:check --seed /radar {trendMeme}`, seeded; add a trend-source sample Proposal to the seed set): the button, the three ideas' provenance block, a hostile subject as one escaped line; keyboard: `--keys "focus=[data-test=radar-ideas]"`; no overflow at 390 or 1240 px.
- [ ] **Real run, once** (not a test): one real run on a current Trend; paste the three ideas, the Est. usage and the clones avoided into Comments.
- [ ] Type-check, `pnpm lint` and the full `pnpm check` pass, run once before the commit.

## Constraints

- Follow `docs/agents/worker-rules.md`. argus writes text for the Operator and launches nothing (ADR 0002). No new Brain task, no new host. No RegExp from any Trend text; nothing fetches a URL from a feed.
- Commit subject `Trend radar ticket 07: Make ideas from a Trend through the meme-ideas path`, body ends with `Ticket: .scratch/trend-radar/issues/07-make-ideas-from-a-trend.md`. No `Closes #N`.

## Comments
