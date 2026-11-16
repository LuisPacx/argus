# 07: The War Room shows a Meta's name with the themes merged under it, and checks it seeded with `page:check`
**Model:** sonnet / medium. One field through the read API and view layer and one list in an existing card, in the pattern of ticket 02. No rule, no Brain call. The care is in untrusted text (names and theme labels from the AI step and from creators) and in the phone width.

**What to build:** a Meta card on `/` and `/meta` shows the subject's name as its title (for example `GTA 6`) and, under it, the launch themes that were merged into it (for example `Lucia From GTA 6 - 270 tokens, 156 creators`, `GTA VI`, `Vice City`), so the reader sees why one Meta stands for several spellings and can spot a bad merge. Watching rows show the same. Decided by the user on 2026-11-16 (`.scratch/cos.md`: "USER: all as recommended" Q11, "MR ... 07 War Room name+merged themes"; the stored shape and the reasons are in `docs/adr/0015-metas-are-found-top-down.md`, decision 4, "a bad merge is visible", and in ticket 06).

**Status:** done

**Blocked by:** 06 (it stores `themes` and `named_by` on each `meta_current` row and returns them from `Datastore.currentMetas()`). Do not start before 06 is merged: the field does not exist before then.

## What is there today (read 2026-11-16)

- `GET /api/current-meta` (`server/api/current-meta.get.ts`) returns `CurrentMetaResponse` from the pure `currentMetaResponse` (`packages/core/src/meta/api.ts`, `CurrentMetaApiRow` at `:127`): key, label, leader, holding, enteredAt, counts, topTokens, summary, summarySource, newMeta, ideas.
- The view: `currentMetaView` (`apps/warroom/app/utils/meta.ts:318`, `CurrentMetaPayloadRow` `:233`, `CurrentMetaRowView` `:247`) clamps every string (`clampText`) and the card `components/CurrentMeta.vue` (96 lines) renders it as text: label (`data-test="current-label"`), cooling pill, New Meta pill, leader line, summary, copies line, top tokens, meme ideas. Links only through `safeHttpUrl`.
- Seed data for `pnpm page:check --seed`: `scripts/page-seed.mjs` builds two Metas and two Watching rows with `aMeta` from `packages/core/src/testing/meta-current.ts` (labels `SEED Empty Chair`, `SEED Lobster Hat`, `SEED Cloud Cat`, `SEED Moon Dog`) and a hostile Proposal fixture; `STANDARD_PATHS` (`:12`) includes `/`, `/meta` and `/meta#all-launch-themes`. Live rows are empty most of the time, so a card with merged themes is only visible seeded.
- After ticket 06 each stored row has `namedBy` (`ai` or `rules`) and `themes` (up to 12 `{key, label, tokens, creators}`, label cleaned and cut, still creator-written text).

## Approach (a default; say if you want it changed)

1. **API.** `CurrentMetaApiRow` gains `themes: { label: string; tokens: number; creators: number }[]` (at most 12; the theme `key` is not sent: the page has no use for it) and `namedBy: "ai" | "rules"`; `currentApiRow` fills them from the stored row. `GET /api/metas` and the launch-theme rows are untouched. An older run with no `themes` gives `[]`.
2. **View.** `CurrentMetaRowView` gains `themes: { text: string }[]` and `moreThemes: number` (themes beyond the first 5 shown, from the count), and `grouped: boolean` (true when there are 2 or more themes, or one theme whose label differs from the title after normalising case and spaces, so a Meta that merged nothing shows no list). Each theme line is one string, `<label> - N tokens, M creators`, the label through `clampText(label, 60)`, numbers through the existing formatters. The title is the clamped label as today (now the subject's name). A theme whose label equals the title (after the same normalising) is shown first only when others follow it; a row with no `themes` renders exactly as it does today.
3. **Card.** In `CurrentMeta.vue`, under the title and the leader line and above the summary, a short `<ul data-test="current-themes">` headed by a faint `Includes` word (`data-test="current-themes-title"`), one `<li data-test="current-theme">` per theme, `+N more` as one `<li data-test="current-themes-more">`; the same block for Watching rows. Styles use the existing tokens, text wraps (`min-w-0 break-words`), nothing is a link, no raw-HTML directive. `namedBy: "rules"` adds nothing visible by default (open question 2).
4. **Seed.** `aMeta` accepts `themes` and `namedBy`; `scripts/page-seed.mjs` gives `SEED Empty Chair` three themes (one long unbroken 120-character label and one with markup characters, as the hostile card already does) and `SEED Lobster Hat` seven (so `+2 more` shows), and leaves `SEED Cloud Cat` with none. `scripts/page-seed.test.ts` is updated to expect them.
5. **Docs.** `docs/architecture.md` hand-written Meta paragraph gets one sentence; GLOSSARY needs nothing beyond what ticket 06 wrote.

## Acceptance criteria

- [ ] **API** (`server/test/current-meta.test.ts`, seeded store): a stored Meta with 3 themes returns `themes` with label, tokens and creators in stored order and `namedBy`; 12 stored themes return 12 and a stored row with 20 themes (from a hand-written store) returns at most 12; a row from before ticket 06 returns `themes: []`; the theme `key` and any extra stored field are not in the payload; `GET /api/metas` is byte-for-byte unchanged.
- [ ] **View** (`server/test/current-meta-render.test.ts`, `meta-view.test.ts`): `currentMetaView` lists the first 5 themes as `<label> - N tokens, M creators` and `moreThemes` is 2 for 7; a theme label of 100,000 characters is cut to 60, one with `<img src=x onerror=1>` and newlines is kept as plain text on one line; a Meta with no themes, or with only a theme equal to its title, has `grouped` false and renders the card exactly as before (the existing render snapshots unchanged); Watching rows get the same.
- [ ] **Render** (same files, `renderToString` of `CurrentMeta.vue`): `data-test="current-themes"` is present with one `current-theme` per shown theme and one `current-themes-more` for the overflow; markup in a label appears escaped, never as an element; the title is the Meta's name, not a theme label; no theme is a link.
- [ ] **Seed** (`scripts/page-seed.test.ts`): the seeded Metas carry the themes described (3 with a hostile label, 7 with overflow, 0), written through the production Datastore path.
- [ ] **Browser, seeded** (`pnpm page:check --seed --all`, which covers `/`, `/meta` and `/meta#all-launch-themes`; say in the box that the run was seeded; never open or resize the user's Chrome): exit 0, 0 console, page or request errors, no horizontal overflow at 390 px for `/` and `/meta`, 1240 and 390 px screenshots cited by path, and the screenshot read to confirm that `SEED Empty Chair` shows its three themes (the 120-character label wraps inside the card) and `SEED Lobster Hat` shows five and `+2 more`. Also `pnpm page:check --seed /meta` once on its own for the card at both widths.
- [ ] **Keyboard and no regressions:** the `<details>` "All launch themes" keyboard check from ticket 02 (`--keys "focus=[data-test=all-launch-themes-summary],Enter" --watch [data-test=all-launch-themes]`) still passes seeded; the New Meta banner, cooling pill, summary and meme ideas render as before (existing tests green, not loosened).
- [ ] **Live read** (after the worker has run ticket 06 once; not a test): `curl -s localhost:<warroom port>/api/current-meta` on the live War Room, GET only, and paste the Metas' `label` and `themes` in Comments. A day with no Meta ("No Meta right now") is a valid result: say so, and the seeded run is the evidence.
- [ ] Type-check and the full `pnpm check` pass, run once before the commit.

## Constraints

- Text only: no raw-HTML directive anywhere; every payload field clamped in the view; read-only API (no command, no write); no new host; no new rule and no Brain call. Do not change the Hot-now replacement (New Meta), the launch-theme list, or the summaries.
- Browser boxes follow `docs/agents/worker-rules.md`: `pnpm page:check` headless on a throwaway profile, the seed through `--seed`, never a hand-seeded `.backup` copy of the live DB.
- Follow `docs/agents/worker-rules.md` and `CODING_STANDARDS.md`. Commit subject `Meta redesign ticket 07: War Room shows a Meta's name with its merged themes`, body ends with `Ticket: .scratch/meta-redesign/issues/07-war-room-meta-name-with-merged-themes.md` before the trailers. No `Closes #N`.

## Open questions (defaults apply unless the user says otherwise)

1. **How many themes are shown.** Default 5, then `+N more` (the stored list holds up to 12). Say if you want all 12, or the list collapsed in a `<details>`.
2. **Show how the name was made?** Default no marker. Alternative: a small `grouped by rules` note when `namedBy` is `rules` (the AI step was off or over its cap), so a stale-looking name explains itself.
3. **The word.** The card says `Includes` over the themes and the title is the subject's name; the user's word is narrative, GLOSSARY keeps Narrative for another thing (ticket 06 question 4).

## Comments

- **Built 2026-11-16** with the defaults (5 themes then `+N more`, no `namedBy` marker, the word `Includes`). `CurrentMetaApiRow` gains `namedBy` and `themes` (label, tokens, creators; max 12; no key); the view gains `themes`, `moreThemes`, `grouped`; the card shows the list for Metas and Watching. Seed: Empty Chair 3 themes (a 120-character label and a markup one), Lobster Hat 7, the Watching rows none. The seeded `page:check --seed --all` run (and `--seed /meta` with the details keyboard check) exited 0 with no console, page or request errors and no overflow at 390 px; the 390 px screenshot showed the three Empty Chair themes (the long label wrapped) and five Lobster Hat themes with `+2 more`. Screenshots deleted. The live read box is still open (needs the worker to have run ticket 06). Boxes left unticked for review.

- **Written 2026-11-16** from the user's decisions in `.scratch/cos.md`. Code read: `meta/api.ts` (`CurrentMetaApiRow`), `apps/warroom/app/components/CurrentMeta.vue`, `apps/warroom/app/utils/meta.ts` (`currentMetaView`), `scripts/page-seed.mjs`, `packages/core/src/testing/meta-current.ts`, ticket 02 (the pattern and the page:check recipe).
