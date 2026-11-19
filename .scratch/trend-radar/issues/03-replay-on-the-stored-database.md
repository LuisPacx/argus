# 03: Replay on the stored database: when did each known subject first show up
**Model:** sonnet / medium. A deterministic harness over data already on disk, reusing the radar's own counting and scoring. No model, no network. The care is honesty about what 13 days can and cannot show.

**What to build:** a command that runs the radar's own key, phrase-count and score rules over the stored `signals` (13 days of Google Trends and RSS items, plus every PumpPortal create) and prints, for each known subject, when the radar's rules would first have flagged it, when the first source carried it, and when the first matching create appeared. Useful alone, and before the live radar is trusted: it says whether the free sources give any lead for the subjects the Operator knows (Clawd, the Hulk, Anthropic IPO, Genny, the GTA clips), which is the research's own "before writing any code, replay it for free" step.

**Status:** ready-for-agent

**Blocked by:** 02
It needs ticket 02's phrase counter and score.

## Design

- `pnpm radar:replay` (script `scripts/radar-replay.mjs`, like `meta-replay.mjs`): reads a **copy** of the live database made with SQLite's `.backup` into the repo's scratch area on the home disk (never a hand-seeded copy, never the live file; `scripts/live-db-guard.mjs` rules apply; delete the copy at the end), walks time forward in 15-minute ticks, feeds the stored Google and RSS Signals as readings through the same functions the live job uses, and prints a table.
- The subject list is a small committed file `scripts/radar-replay-subjects.json`: `{ label, phrases, knownAt? }`. First entries: Anthropic IPO, Clawd, the Hulk (IShowSpeed), Genny, GTA VI. Each entry's "first matching create" is the first stored `pumpportal:events:create:` Signal whose normalised name or ticker contains every word of a phrase (no RegExp), and its create count by distinct creators in the next 24 hours.
- Output per subject: first source reading (which source, when), the radar's first flag (score reaches 40), the first matching create, and the lead in minutes (negative means the radar was late; "never" when it never flagged). One line of summary: how many of the subjects the radar flagged before their first create, with n shown. The replay reports the number it finds; it is no reason to change a threshold by itself, and it says so in its output: the stored feeds hold only what the sources carried, so the replay can show no lead for a subject no source carried (the research expects none for Clawd and the Hulk).
- Also run the untokenized rule over the replay's flagged subjects at their flag time, from the stored creates only (no DexScreener): print how many already had 5 or more distinct creators (`tokenizing`).

## Acceptance criteria

- [ ] **Determinism** (`radar-replay.test.ts`, a small fixture database via `testing/temp.ts`): the same input gives byte-identical output; the ticks use the stored times, not the clock.
- [ ] **Same code as live** (`radar-replay.test.ts`): the replay imports the job's score and phrase functions (a test fails if the script re-implements the 40-point bar or the 3-feed rule).
- [ ] **Known cases on a fixture**: a fixture of 13 feeds carrying "Anthropic IPO" 9 hours before the first matching create gives a lead of about 540 minutes and a flag; a fixture where no feed carries the term gives "never" and still reports the first create time; a create whose name has every word of a phrase in a different order matches.
- [ ] **Safety**: the script refuses to read the live database file directly (it takes a `.backup` copy path or makes one), writes no file inside the repository other than its own copy in the scratch area, deletes the copy, and builds no RegExp from stored text.
- [ ] **Real run, once** (not a test): run it on a fresh backup copy of the live database, paste the table and the one-line summary into Comments, and state in one sentence which of the five subjects the free sources would have led. Delete the copy.
- [ ] Type-check, `pnpm lint` and the full `pnpm check` pass, run once before the commit.

## Constraints

- Follow `docs/agents/worker-rules.md` (temp files via `testing/temp.ts`; no `/tmp`; the backup copy goes on the home disk).
- Commit subject `Trend radar ticket 03: replay on the stored database`, body ends with `Ticket: .scratch/trend-radar/issues/03-replay-on-the-stored-database.md`. No `Closes #N`.

## Comments
