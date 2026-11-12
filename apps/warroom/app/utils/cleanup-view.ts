// What the Proposal page needs for "Clean up build". Types only: the server fills it (server/utils/cleanup.ts), the component draws it as text.

export interface CleanupViewPlan {
  worker: { name: string; found: boolean };
  /** `name` is `owner/slug`, or null when no repo is recorded and the checkout names none. `legacy`: a Build from before repos were recorded. */
  repo: { name: string | null; found: boolean; legacy: boolean };
  directory: { path: string; found: boolean };
}

export interface CleanupView {
  /** The "Clean up build" button is shown: the Proposal may be cleaned (never a launched one) and has not been cleaned already. */
  available: boolean;
  /** Why not, for a status that could have been (null when available or when the Build has nothing to clean). */
  refusal: string | null;
  /** The dry run: from argus's records and a read-only look at the disk. Null when the status is not one a clean-up applies to. */
  plan: CleanupViewPlan | null;
  /** The repo name the Operator must type to confirm (legacy Builds only), else null. */
  confirmName: string | null;
  /** The one-line results of the latest clean-up run, in order. */
  results: string[];
  /** Everything was gone or nothing of ours was left. */
  cleaned: boolean;
}
