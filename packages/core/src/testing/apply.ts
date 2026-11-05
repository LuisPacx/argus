import { applyPendingCommands, type ApplyOptions, type Command, type RequeueChecks } from "../lifecycle.ts";
import type { Datastore } from "../datastore.ts";
import { tempDir } from "./temp.ts";

/** `applyPendingCommands` for tests that do not care about re-queue leftovers: an empty build root and no GitHub repo unless `opts` say otherwise. */
export function applyPending(store: Datastore, onError?: (command: Command, error: unknown) => void, opts: Partial<ApplyOptions & RequeueChecks> = {}): number {
  return applyPendingCommands(store, onError, { buildRoot: tempDir("argus-apply-"), githubRepoExists: () => false, ...opts });
}
