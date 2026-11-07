# War Room "Soft Rows" in Stitch (2026-11-06)

Project: https://stitch.withgoogle.com/projects/17162969221930921214 ("argus War Room — Soft Rows"), design system "Argus Soft Rows" (assets/8766477388124340022: Plus Jakarta Sans, indigo #5B5BD6, light neutral #F2F3F7, 12px/round-8 base; tokens from the Soft Cards section of ../figma/README.md, rest carried by designMd). Stitch cannot take a reference image, so the list was recreated from a text prompt describing soft-rows-list.png. Images are 2560 px wide (2x of 1280-wide Stitch frames; content width ~1240 of 1280, i.e. slightly narrower margins than the 1440 Figma frame).

Brief change: details are separate pages, not a modal. Screen 2 (modal) was not produced ("not chosen"). Rows link to detail pages.

| # | Image | Fidelity / drift |
|---|-------|------------------|
| 1 | 01-proposals.png | Good, closest to soft-rows-list.png (nav, header band, rows, bars, pills, 190px actions column unclipped). First generation drifted (invented nav labels, "View dispatch" links, pagination, white top bar, invented descriptions); an edit_screens fix broke the render, so a clean regeneration with a stricter prompt was used. The broken first screen (id 029d2c84...) and no other leftovers remain in the project; ignore it. |
| 3 | 03-proposal-detail.png | Good. Two columns, all content incl. Narrative link, evidence links, score + rationale, collisions, actions. Drift: long evidence URLs ellipsised, Brain runs line in monospace, header margins 20px. |
| 4 | 04-narratives.png | Good. Drift: invented subtitle "Clusters of recent Signals, newest first" (real page has none); chevrons added. |
| 5 | 05-narrative-detail.png | Good. Drift: invented "8 total" label in Signals card; page margins ~32px vs 44px elsewhere; rationales shortened. |
| 6 | 06-activity.png | Good. Real fields only. "15 of 30 Proposals today" matches the running API (list screen shows 45 from the Figma image). |
| 7 | 07-rubric.png | Good. Editable form rows with Weight, gate sentence, Save Rubric, Discard changes. |
| 8 | 08-proposal-detail-spec-drafted.png | Spec editor is part of /proposals/:id (no separate page). No live Proposal is spec-drafted, so this is illustrative: spec text, rationale and "Target: Cloudflare Workers" row are invented by Stitch. Layout good. |

Real values come from read-only GETs on :3100 (Tipoff Tracker id 15, Narrative 444, activity, rubric v1).
