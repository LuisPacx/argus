// The Proposals list sorts newest first in the War Room. The API's own default stays score (the worker shares the datastore),
// so the page always sends its sort explicitly and only leaves the default out of the page URL.
export const DEFAULT_PROPOSAL_SORT = "newest";

/** The sort in the page URL: the default is left out. */
export const proposalUrlSort = (sort: string): string | undefined => (sort === DEFAULT_PROPOSAL_SORT ? undefined : sort);

/** The `sort` sent to /api/proposals: always explicit. */
export const proposalApiSort = (sort: string): string => sort || DEFAULT_PROPOSAL_SORT;

/** The cap text shared by the Proposals indicators: it counts a rolling 24 hours, not a calendar day. */
export const proposalCapText = (used: number, cap: number): string => `${used} of ${cap} in the last 24 h`;
