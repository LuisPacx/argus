# 02: Qualifying bars, grouped Moments, dedupe and growth
**Model:** sonnet / medium. Plain code on data ticket 01 already stores: thresholds, grouping, tiers. One new search group. No model, no new trust boundary beyond 01's.

**What to build:** the scanner stops listing posts and lists **Moments**. The manual scans' qualifying rules become code: spellings search (group A), the three bars, grouping of posts into one Moment, dedupe, and "grown". The page shows `qualifying` Moments above `rising` ones, each with its best post, how many accounts have spread it, and the time of every tier change. Useful alone: the Operator gets the shortlist the 15:20 manual scan produced, without a judge or a coin side yet.

**Status:** ready-for-agent

**Blocked by:** 01.

## Design

- **Group A query** (`moments/query.ts`): `(<spellings joined by OR>) min_faves:2000 since:<start>`, Top tab, added to ticket 01's two group B queries: 3 loads a scan in all (the manual scan used 13). A per-topic scroll limit stays 3.
- **Bars** (`moments/config.ts`, from the brief; `.scratch/research/gta6-post-release.md`, "Scan 2026-11-19 15:20 UTC"): qualifying if the best post has at least 200,000 views or 5,000 likes, or at least 3 distinct accounts each have at least 20,000 views on posts in the Moment; rising if the rate (average or recent, ticket 01) is at least 50,000 an hour and no bar is met. Posts before the topic's start are ignored; a post that quotes a post older than the start is flagged `olderOrigin` where the DOM carries the quoted link (not hidden: the old clip is evidence, the SicklyTheNinJa case where the original was from the evening before). A post with no views shown qualifies only on likes.
- **Grouping:** first by quote link (a post quoting a member joins it), then by text closeness under the in-process embedder (ADR 0007; look at how `narratives.ts` loads and uses it) above a conservative threshold in config. A group of one post is a Moment. The threshold is tuned on the fixture set below and recorded in Comments with the pairs it merged and split.
- **Identity and dedupe:** a Moment's id is its earliest member's status ID. A new post that groups with a Moment joins it and creates no row. Merging two Moments (a later post bridges them) keeps the older id and records the merge.
- **Tier and history:** `rising`, `qualifying`, `cooling` (flagged, recent rate under 5,000 an hour for 6 hours). Each change is a row with its time. The Operator can mark a Moment `ignored` (a War Room write limited to this one mark, through the same insert-only pattern as other Operator marks; the worker applies it); an ignored Moment is hidden and never re-flagged.
- **Grown:** a Moment the Operator has seen (the page records "seen at" views when he opens it) is marked grown when its best post's views are 3 times what they were then.

## Acceptance criteria

- [ ] **Bars** (`qualify.test.ts`): each bar alone qualifies (200K views; 5K likes with views missing; 3 accounts at 20K+ each); two accounts at 20K+ do not (Mandy at 07:21: 188K and 80K); a post at 199,999 views and 4,999 likes with 30K an hour does not qualify and is not rising; a post before `startsAt` is ignored; 50K an hour with 30K views is rising and with 19K views is not (the floor); the rule table is checked against the 15:20 scan: the six moments' recorded numbers qualify and the two "rising only" posts (POPTime 114K an hour, OLL 53K an hour) are rising, not qualifying.
- [ ] **Grouping** (`group.test.ts`, fixture of the 15:20 scan's post texts transcribed by hand from the notes, labelled as transcribed): FelpsCrypto's and nfxce's Area 51 posts group; the Mandy clips group; the Fat Jason and Muscle Mommy posts are the open case (the notes count one "body customisation" Moment with two accounts above 600K and write two ideas): the test records what the chosen threshold does with them and says it is a judgement call, asserting neither way, and the Area 51 and scooter posts must not merge with it; a quote of a member joins it; a post bridging two Moments merges them to the older id; the threshold's merged and split pairs are listed in the test as the evidence for its value.
- [ ] **Dedupe and tiers** (`moments-store.test.ts`): a repeated scan adds readings and no second Moment; rising to qualifying records one tier change with its time; a cooling Moment that regains 50K an hour is `rising` again with a new row; ignored stays hidden through every later reading; "grown" is set at 3 times the seen views and not before; the schema is idempotent and an old database opens.
- [ ] **Worker** (`moments-job.test.ts`): a scan now loads 3 URLs (A, B Top, B Latest) within the per-scan cap; the 13-load manual plan is refused as over the cap; stop and lock behaviour from 01 unchanged.
- [ ] **Page** (`moments-render.test.ts`, `pnpm page:check --seed /moments`, seeded): qualifying above rising; each row shows best post, the number of accounts at 20K+, tier and the time of the last change, "grown", and "older origin"; the ignore control posts one mark and the Moment disappears on the next load; hostile text escaped; no overflow at 390 or 1240 px; keyboard: `--keys "focus=[data-test=moment-ignore]"` focuses without activating (the script blocks non-GET).
- [ ] Type-check, `pnpm lint` and the full `pnpm check` pass, run once before the commit.

## Constraints

- No model call and no DexScreener call in this ticket. Same X rules as 01 (read-only, caps, stop on signal). No RegExp from text.
- Commit subject `Moment scanner ticket 02: qualifying bars, grouped Moments`, body ends with `Ticket: .scratch/moment-scanner/issues/02-qualifying-bars-grouped-moments.md`.

## Comments
