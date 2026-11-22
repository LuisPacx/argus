# 11: Automatic ideas and a Telegram nudge (the full version)
**Model:** sonnet / high. The first automatic path from third-party X text to a paid model run and an outgoing message. It is the step the Operator said to decide only after live precision is known.

**What to build:** two switches, both off by default. `ARGUS_MOMENT_AUTO_IDEAS=1`: a Moment that first qualifies, is judged `moment` or `reaction`, is coin-side `open`, has no `nsfw`, `political` or `older origin` flag and has not been asked for, gets one automatic trio, under a cap of its own. `ARGUS_MOMENT_NUDGE=1`: a short Telegram message when such a Moment first qualifies. Useful alone: ideas wait in the War Room when the Operator comes back, and he hears about the rare big one.

Status: wontfix

**Blocked by:** 06, 07, 08
Also an Operator go, which is not a ticket: do not start until the Operator has read the Scorecard (ticket 07) after at least 14 days of live scanning and written "go" in Comments with the cap he wants (4 a day was named). When it is written, change Status to ready-for-agent. If the scorecard shows precision under the spec's 40 percent or more than 10 false flags a day, report that instead of building.

## Design

- **Automatic trio.** A job kind beside ticket 06's operator-pressed one: trigger `moment-auto`, key `moment:<id>`, same Moment block, same prompt, same checks, version 4 snapshot. One automatic trio per Moment, ever (as a news story gets one), and none if the Operator already made one. Own cap: 4 runs in any rolling 24 hours (`ARGUS_MOMENT_AUTO_MAX_PER_DAY` can only lower it; ceiling 10), taken from the research budget, not added to it, and independent of the angle allowance and the 8-a-day Meta cap (a busy day of Moments must not starve the Metas, and the reverse). Newest qualifying first. A capped Moment is recorded once and tried again while it is live and still `open`.
- **Re-check before the run:** at run time the Moment must still be live, judged, `open` or `contested` with no real clone at $50,000 or more, else it is skipped with the reason. This is checked in code on the stored trace and re-traced once if older than one scan.
- **Nudge.** One Telegram message per Moment at its first qualifying tier, never for `rising`, never for an ignored or folded Moment: text of at most 400 characters, built by code from the subject, views, views an hour, coin-side state and the War Room page path; the post link as plain text; no model-written text in the message. At most 6 a day and 1 an hour; a message that cannot send is dropped, not queued past a day (the existing Telegram queue's rules).
- **Telemetry for the verdict.** The scorecard gains ideas made automatically, how many the Operator shortlisted or dismissed, and the ratio against pressed ones, so the switch can be judged and turned off.

## Acceptance criteria

- [ ] **Selection** (`auto-ideas.test.ts`, fake Brain and fake trace): a qualifying, judged, `open` Moment with no blocking flag gets one trio; each of `nsfw`, `political`, `older origin`, kind `news`, state `taken`, an ignored mark, an existing trio of either kind, and a Moment cold at run time is skipped with a recorded reason and no model call.
- [ ] **Cap and budget:** the 5th run in 24 hours is refused with no model call; the Meta cap and the angle allowance are unaffected in both directions (tests for each); the research budget gate applies; a rate limit, interrupt, dry run and switch off leave the Moment waiting.
- [ ] **Safety:** the prompt, parser, name-copy check against the clones, legitimacy text and `real person` rule are exactly ticket 06's (the same functions, asserted by test, no copy); a hostile post cannot change the output rules; nothing fetches a URL.
- [ ] **Nudge** (`nudge.test.ts`, the Telegram fake): sent once at the first qualifying tier and not for rising, ignored, folded or taken Moments, or on a later tier change; at most 6 a day and 1 an hour; the text holds no model output and no markup; a Telegram failure never delays or fails a scan; switch off sends nothing.
- [ ] **Switches:** both are off by default and independent; with both off the behaviour is ticket 06's exactly (the existing tests pass unchanged).
- [ ] **Live read, once** (Comments): after the Operator turns a switch on, one automatic trio's request, Proposal ids, cost and the nudge text pasted. Leave open until it happens.
- [ ] Type-check, `pnpm lint` and the full `pnpm check` pass, run once before the commit.

## Constraints

- The Operator still launches; argus writes text and sends one message (ADR 0002). No automatic shortlist, approval or Build. No X action beyond the scanner's. The Telegram message never contains text a model wrote or a post's raw text beyond the cut subject the judge produced and code cleaned.
- Commit subject `Moment scanner ticket 11: automatic ideas and a Telegram nudge`, body ends with `Ticket: .scratch/moment-scanner/issues/11-automatic-ideas-and-telegram-nudge.md`.

## Comments
- Superseded by .scratch/human-researcher (ADR 0017: agents run only on Operator trigger)
- 2026-11-21 cos triage: ADR 0009, the Operator researches; the automatic moment loop stays off (ARGUS_MOMENTS)
