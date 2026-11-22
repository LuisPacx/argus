// War Room ticket 20: lists of Proposals leave out closed and dismissed ones by default; a link toggle (URL query `closed=1`) shows them.
export const HIDDEN_STATUSES: readonly string[] = ["closed", "dismissed"];

/** `closed=1` in a page URL query. */
export const showHiddenFromQuery = (raw: unknown): boolean => raw === "1";

/** Empty-list text when no Proposal is shown: says so when the hidden ones are the reason. */
export function emptyProposalsMessage(hiddenCount: number): string {
  if (hiddenCount === 0) return "No Proposals yet.";
  return hiddenCount === 1 ? "All 1 Proposal is closed or dismissed." : `All ${hiddenCount} Proposals are closed or dismissed.`;
}

/**
 * Splits a list of Proposals for display. `status` is the Status filter ("" = none): an explicit closed or dismissed filter shows those rows
 * and offers no toggle. `hiddenCount` is how many closed and dismissed rows the list holds; `toggle` says whether to offer the link.
 */
export function proposalVisibility<T extends { status: string }>(list: readonly T[], opts: { status: string; showHidden: boolean }): { shown: T[]; hiddenCount: number; toggle: boolean } {
  if (HIDDEN_STATUSES.includes(opts.status)) return { shown: [...list], hiddenCount: 0, toggle: false };
  const hiddenCount = list.filter((p) => HIDDEN_STATUSES.includes(p.status)).length;
  return { shown: opts.showHidden ? [...list] : list.filter((p) => !HIDDEN_STATUSES.includes(p.status)), hiddenCount, toggle: hiddenCount > 0 };
}
