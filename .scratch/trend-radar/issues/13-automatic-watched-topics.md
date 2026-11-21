# 13: Automatic Watched topics from the best Trends
**Model:** sonnet / high. The first automatic path from third-party feed text to searches on the logged-in X account. It shares the account with the Study; a wall stops both. The care is the slot rule, the expiry and the switch.

**What to build:** behind a switch that is off by default, each hour the worker picks the best Trend that is `untokenized` or `contested`, scores 60 or more, is named, is not already a topic, has no `nsfw` or `political` flag, and asks the moment scanner for a topic of source `trend`. These topics hold **at most 2 of the 4 slots**, never displace a Meta or an Operator topic, live 12 hours unless the Operator keeps them, are released after 6 empty scans, and at most 6 new ones start in a day. The scanner then looks for clips under them as for any topic. Useful alone: the radar's best subjects get their clips found without the Operator pressing anything, inside the account's existing load caps.

**Status:** superseded

**Blocked by:** 06, 12
Spec: section 6.2. ADR 0016 decision 4. Moment scanner spec sections 4 and 7 and ADR 0009's 2026-11-19 amendment (shared account, 100 loads a day in week 1, 300 after a week with no wall) and its one-line pointer amendment of this feature (a Trend-sourced topic is a third origin of topic text under the same limits).

## Design

- **Switch** `ARGUS_RADAR_AUTO_TOPICS=1`, off by default; junk is an error. It also needs `ARGUS_MOMENTS=1` and the scanner not stopped.
- **Picker** (`radar/auto-topics.ts`, plain code, no model): once an hour, at most one new topic. Candidates are shown Trends with a score of 60 or more, state `untokenized` or `contested`, a plain subject and phrases from ticket 04, no `nsfw` or `political` flag, not ignored, not already a topic, first flagged in the last 6 hours. Highest score wins; ties go to the older. All numbers in `radar/config.ts`, lowerable and never raised by configuration.
- **Slots.** Through ticket 06's request path, with `source = trend` and `auto = 1`: refused when 2 automatic topics are already active or when the scanner's 4 slots are all taken; **never displaces** a Meta or an Operator topic (the scanner's ordering already puts Metas first, then Operator topics, then trend topics); an automatic topic is the first to be dropped when a Meta needs a slot (the scanner's ticket 05 turn-taking: add the rule here, with a test, if the merged scanner does not have it).
- **Life.** 12 hours unless the Operator presses Keep (a Keep makes it an Operator-style topic with a 7-day expiry); the scanner's rule "6 scans in a row with nothing flagged, then half rate" still applies to it, but the radar releases an automatic topic after **3 empty scans** (`autoReleaseEmptyScans`, in `radar/config.ts`), a number that can happen inside its life: in **week 1** (the scanner's 100 loads a day, 2 to 3 loads a scan, so about one scan per topic every 3 hours with 4 topics) 3 scans take about 9 hours of a 12-hour life; from week 2 (300 loads, about hourly) about 3 hours. A topic that has had fewer than 3 scans when its 12 hours end simply ends. At most **6 new automatic topics in any rolling 24 hours** (`ARGUS_RADAR_AUTO_TOPICS_PER_DAY` can only lower it): two slots at a 12-hour life allow 4 a day if each runs its life, early release can allow up to 6, and the scanner's load cap can scan all of them.
- **Loads.** The radar adds none of its own. Topics share the scanner's caps and ramp: week 1 is 100 loads a day, about one scan per topic every 3 hours with 4 topics; from week 2, 300 loads, about hourly. The page shows each automatic topic with its scans and loads.
- **Stop rule.** If the scanner's shared stop state is `stopped`, nothing is requested. A stop that happens while an automatic topic is active also ends that topic for the day. The radar never resumes the scanner.
- **Visibility.** `/radar` shows which Trends became topics automatically and when, and `/moments` marks `trend` topics as automatic.
- **No automatic ideas.** Nothing here starts a `meme-ideas` run.

## Acceptance criteria

- [ ] **Picker** (`auto-topics.test.ts`, fixtures): the highest-scoring eligible Trend is chosen; a `taken`, `tokenizing`, `not traced`, `nsfw`, `political`, ignored, unnamed, already-watched or 7-hour-old Trend is not; at most one a tick and a second pick in the same hour is refused; with the switch off nothing is requested.
- [ ] **Slots** (`auto-topics-slots.test.ts`, real topics table on a temp dir): with 2 Metas and 1 Operator topic active, one automatic topic fits and a second is refused (cap of 4 and cap of 2 automatic); with 2 automatic topics active a third is refused; a Meta arriving when 4 are active drops an automatic topic, never an Operator or another Meta topic; an Operator's press of Watch on X is unaffected.
- [ ] **Life** (`auto-topics-life.test.ts`, fake clock): an automatic topic ends 12 hours after it began; Keep moves it to 7 days; 3 empty scans release it early (and with the week-1 pace of one scan per 3 hours, the third empty scan happens at about 9 hours, before the 12-hour end; a test with that pace shows it); a topic with only 2 scans in its 12 hours ends without release; two slots with a 12-hour life start at most 4 topics a day when each runs its life, and early release never takes the count past 6; at most 6 new automatic topics start in a rolling 24 hours and `ARGUS_RADAR_AUTO_TOPICS_PER_DAY=9` is an error.
- [ ] **Stop** (`auto-topics-stop.test.ts`): with the scanner's state `stopped` nothing is requested and active automatic topics load nothing; a second wall within 7 days does not make the radar request anything on its own; the radar never writes the scanner's stop state.
- [ ] **Safety** (`auto-topics-safety.test.ts`): a Trend whose raw key is `from:elonmusk -filter:links min_faves:0` becomes a topic only through the scanner's cleaner (the cleaned words and nothing else); nothing in the radar calls the browser or loads a page.
- [ ] **Render** (`radar-render.test.ts`, `pnpm page:check --seed /radar /moments`, seeded): the "automatic" badge, the time it began and its expiry, Keep; no overflow at 390 or 1240 px.
- [ ] Type-check, `pnpm lint` and the full `pnpm check` pass, run once before the commit.

## Constraints

- Follow `docs/agents/worker-rules.md`. This ticket must not change the scanner's load caps, the ramp or the allowed pages. The switch is off by default and is turned on by the Operator, not by this ticket.
- Commit subject `Trend radar ticket 13: automatic Watched topics from the best Trends`, body ends with `Ticket: .scratch/trend-radar/issues/13-automatic-watched-topics.md`. No `Closes #N`.

## Comments
- Superseded by .scratch/human-researcher (ADR 0017: agents run only on Operator trigger)
