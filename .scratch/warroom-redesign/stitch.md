# War Room redesign in Google Stitch

Project: "argus War Room redesign", id `8555144023788112596` (https://stitch.withgoogle.com/projects/8555144023788112596), private.
Design system asset: `assets/13871367760889585163` ("Argus Console", dark, Inter + JetBrains Mono, 4px radius, seed #4F8CFF).

## Screens (status honest: see Gaps)

| Page | Screen id | State |
|---|---|---|
| index.vue (Proposals) | not retrievable | rendered: project thumbnail is this screen, saved as `proposals-thumbnail.jpg` |
| proposals/[id].vue | not retrievable | generate call sent, timed out client-side, never appeared |
| narratives/index.vue | not retrievable | same |
| narratives/[id].vue | not retrievable | same |
| activity.vue | not retrievable | same |
| rubric.vue | not retrievable | same |

## Design system choices
- Dark default (bg #0E1116, surface #151A21, hairline #232A33, text #E6EAF0, muted #8B95A3); light twin (bg #F6F7F9, surface #FFF) specified in prompts, not yet rendered.
- One accent, blue #4F8CFF, for links and primary actions.
- Proposal status pills (dot + tint): new blue, shortlisted violet #A78BFA, spec-drafted indigo #818CF8, approved teal #2DD4BF, building amber #F5B83D, built green #3FB950, build-failed red #F85149, needs-human orange #FB8C3C, launched bright green #56D364, closed grey, dismissed grey strike.
- Type: Inter for UI, JetBrains Mono tabular for scores, costs, ids, times.
- Shape/spacing: 4px radius, 8px grid, ~36px rows, hairline borders, no shadows.
- Shell: 208px left sidebar (Proposals, Narratives, Activity, Rubric, worker status dot), top bar with budget meters (Est. usage vs budget, API spend real $ kept apart, New Proposals n / cap).
- Score: five thin segments per Rubric dimension plus "7.4 / 10"; buildability flagged as hard gate.
- Collision chips: clear green, collides amber/red, unknown amber.
- Row actions by status: new Shortlist/Dismiss; shortlisted+specError Retry Spec; spec-drafted Edit Spec; build-failed Re-queue; built Preview/Launch/Mark launched; inline dismiss with Reason.
- Latest Signals as a right rail with source badges.

## Gaps
- `list_screens` and project `screenInstances` stay empty and every `generate_screen_from_text` call times out, so screen ids could not be read. Only the first generation is visible (project thumbnail). Five later screens were requested; their existence is unconfirmed. Open the project link to check; if absent, rerun the prompts (they are short, one per page).
- `update_design_system` dropped the long designMd; palette in it lives in prompts and the project designTheme only.
- Stitch rendered collision "collides" as amber (app uses red) and invented a "Pause Stream" / "STREAM LIVE" control and a "Sort: Score" menu that the app lacks. Rendered rows show Thesis; app fields are Narrative summary, Tech, Why now.
- No HTML export taken (screen file names unavailable).
