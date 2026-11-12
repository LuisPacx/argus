import { CLEANUP_STATUSES, cleanupPlan, cleanupRefusal, type Proposal, type WarRoomStore } from "@argus/core";
import type { CleanupView } from "../../app/utils/cleanup-view.ts";

const PREFIX = "Clean up: ";

/** A clean-up run writes one `status_history` row per artifact: Worker, repo, directory. */
const ARTIFACTS = 3;

/** The latest clean-up run's lines: the last `ARTIFACTS` clean-up rows of the history, in order. */
function latestResults(store: Pick<WarRoomStore, "historyFor">, id: number): string[] {
  return store
    .historyFor(id)
    .filter((h) => h.reason.startsWith(PREFIX))
    .slice(-ARTIFACTS)
    .map((h) => h.reason.slice(PREFIX.length));
}

/**
 * A Proposal with what "Clean up build" would do. Reads only: argus's own records, the disk and the history. The War Room holds no
 * Cloudflare or GitHub credentials, so whether the Worker and the repo still exist is asked by the worker, after the Operator confirms.
 */
export function withCleanup<T extends Proposal>(store: Pick<WarRoomStore, "historyFor" | "brainRunsFor">, p: T, buildRoot: string): T & { cleanup: CleanupView } {
  const results = latestResults(store, p.id);
  if (!CLEANUP_STATUSES.includes(p.status)) {
    return { ...p, cleanup: { available: false, refusal: null, plan: null, confirmName: null, results, cleaned: p.buildCleaned } };
  }
  const refusal = cleanupRefusal(store, p, buildRoot);
  const plan = cleanupPlan(p, buildRoot);
  return {
    ...p,
    cleanup: {
      available: refusal === null && !p.buildCleaned,
      refusal: refusal !== null && !refusal.startsWith("Nothing to clean up") ? refusal : null,
      plan: refusal === null || p.buildCleaned ? plan : null,
      confirmName: plan.repo.legacy ? plan.repo.name : null,
      results,
      cleaned: p.buildCleaned,
    },
  };
}
