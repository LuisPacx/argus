# 19: War Room Proposals list sort and filter
**Model:** sonnet / medium — one datastore query, one endpoint, one controls bar copied from the Narratives list.

**What to build:** Give the Proposals list (`/`) the same sort and filter bar ticket 18 gave the Narratives list. Default order is Score high to low (the Operator's explicit ask), Proposals without a Score last.

**Status:** done

## Scope

Mirror ticket 18's Narratives controls (acceptance criteria "Narratives list controls", URL state, datastore-side sort), commit 4133464: same `SegmentedLinks` and `select-pill` styling, same URL-query handling, same `Clear filters` link, same endpoint shape. Do not change existing row content, actions or messages on `/`. No migration, no new dependency, no `nuxt.config` change.

## Acceptance criteria

- [x] The controls use the same design as the Narratives list bar (Operator): the same pill groups, selects, layout and "Clear filters" link, from one shared component (`ListControls.vue`, extracted from the Narratives page) used by both pages, with no visual or behaviour change on `/narratives`.
- [x] A controls bar above the Proposal rows, in the Narratives list's pill styling, with a sort: Score (high to low, the default, Proposals with no Score last), Newest (created), Recently changed (last update), Est. usage (highest first).
- [x] Filters grounded in real Proposal data: Status (any of the 11 `ProposalStatus` values, default all), Collisions (Clear, Collides, Unknown; a Proposal collides when either check collides, is clear only when both checks are clear, and is unknown otherwise, including a Proposal that was never checked), and Created window (last 24 hours, 7 days, 30 days). A "Clear filters" link appears when a filter is set. The page has a "No Proposals match these filters." empty state.
- [x] Sort and filter state lives in the URL query (defaults omitted; an open New Proposal form, `?new=1`, stays open when the sort or a filter changes) and survives reload and back; invalid values fall back to the defaults on the page.
- [x] Sorting and filtering happen in the datastore: `GET /api/proposals` takes `sort`, `status`, `collision`, `created`; new `Datastore.queryProposals` (also in `WarRoomStore`) applies them in SQL with an optional `limit` applied after sorting (the list itself stays uncapped today). The Score sorted on is the Proposal's Narrative's latest Score total, the same Score the row shows. Response rows are unchanged.
- [x] Endpoint tests (`apps/warroom/server/test/proposals-list.test.ts`, in the style of `narratives.test.ts`): default score order with unscored last and the latest Score counting (not the one proposed on), each sort, each filter and a combination, the limit applied after sorting, 400 for an unknown sort, status, collision or created window.
- [x] `pnpm check` passes.

**Notes (filters dropped, and why):** no Source filter (a Proposal has no Source of its own, only its Narrative does, and the row shows none); no ticker or name search (not asked, no data gap); no "has Spec", "has preview" or "expires soon" filter (derivable from status, or computed in code rather than stored, so they would not sort in SQL). No Score range filter: Score sort already puts the best first. Narrative age sort dropped: it duplicates Newest for research Proposals and is null for hand-entered ones.
