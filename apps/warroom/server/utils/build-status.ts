import { BUILD_TICK_MS, type BuildRefusal, type Proposal, type WarRoomStore } from "@argus/core";

/** What the Proposal page needs to say why an approved Proposal's Build has not started. The same type is the page's, so a renamed field is a type error. */
export interface ProposalBuildStatus {
  /** The latest preflight refusal, or null (not approved, or none). Holds `{ code, message, at }` and no field that could carry a secret. */
  buildRefusal: BuildRefusal | null;
  /** Another Proposal is `building` (only asked for an approved one). */
  buildRunning: boolean;
  /** The worker's build tick in seconds (`BUILD_TICK_MS`, the value its `setInterval` uses): "retried every N s". */
  buildRetrySeconds: number;
}

export function withBuildStatus<T extends Proposal>(store: Pick<WarRoomStore, "buildRefusalFor" | "listProposals">, p: T): T & ProposalBuildStatus {
  const approved = p.status === "approved";
  return {
    ...p,
    buildRefusal: approved ? store.buildRefusalFor(p.id) : null,
    buildRunning: approved && store.listProposals().some((o) => o.status === "building"),
    buildRetrySeconds: BUILD_TICK_MS / 1000,
  };
}
