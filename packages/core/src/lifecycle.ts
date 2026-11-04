import type { Datastore } from "./datastore.ts";

export type ProposalStatus =
  | "new"
  | "shortlisted"
  | "spec-drafted"
  | "approved"
  | "building"
  | "built"
  | "build-failed"
  | "needs-human"
  | "launched"
  | "closed"
  | "dismissed";

export type Actor = "operator" | "system" | "build";

export interface Transition {
  from: ProposalStatus;
  to: ProposalStatus;
  actor: Actor;
  /** Default reason recorded when the caller gives none. */
  reason: string;
}

const DISMISSIBLE: ProposalStatus[] = [
  "new",
  "shortlisted",
  "spec-drafted",
  "approved",
  "building",
  "built",
  "launched",
  "build-failed",
  "needs-human",
];

/** Every transition in docs/architecture.md section 3, as data. */
export const TRANSITIONS: readonly Transition[] = [
  { from: "new", to: "shortlisted", actor: "operator", reason: "Operator shortlisted" },
  { from: "shortlisted", to: "spec-drafted", actor: "system", reason: "Spec drafted" },
  { from: "spec-drafted", to: "approved", actor: "operator", reason: "Operator approved" },
  { from: "approved", to: "building", actor: "build", reason: "Build started" },
  { from: "approved", to: "needs-human", actor: "build", reason: "Spec needs an on-chain program" },
  { from: "building", to: "built", actor: "build", reason: "Deploy ok" },
  { from: "building", to: "build-failed", actor: "build", reason: "Build failed after retry" },
  { from: "building", to: "needs-human", actor: "build", reason: "Spec needs an on-chain program" },
  { from: "built", to: "launched", actor: "operator", reason: "Operator marked launched" },
  { from: "launched", to: "closed", actor: "operator", reason: "Closed after Launch" },
  { from: "new", to: "closed", actor: "system", reason: "stale" },
  { from: "shortlisted", to: "closed", actor: "system", reason: "stale" },
  ...DISMISSIBLE.map((from): Transition => ({ from, to: "dismissed", actor: "operator", reason: "Dismissed" })),
];

export class IllegalTransitionError extends Error {
  constructor(from: ProposalStatus, to: ProposalStatus, actor: Actor) {
    super(`Illegal transition ${from} -> ${to} by ${actor}`);
    this.name = "IllegalTransitionError";
  }
}

/** Returns the table entry for a legal transition, or undefined. */
export function findTransition(from: ProposalStatus, to: ProposalStatus, actor: Actor): Transition | undefined {
  return TRANSITIONS.find((t) => t.from === from && t.to === to && t.actor === actor);
}

export function assertTransition(from: ProposalStatus, to: ProposalStatus, actor: Actor): Transition {
  const t = findTransition(from, to, actor);
  if (!t) throw new IllegalTransitionError(from, to, actor);
  return t;
}

/** The single approval path (architecture section 1). Phase 3 may call it from a score threshold. */
export function approve(store: Datastore, proposalId: number, actor: Actor = "operator", reason?: string): void {
  store.transition(proposalId, "approved", actor, reason);
}

export type CommandType = "shortlist" | "dismiss" | "approve";
export type CommandStatus = "pending" | "applied" | "rejected";

export interface Command {
  id: number;
  proposalId: number;
  type: CommandType;
  reason: string;
  status: CommandStatus;
  error: string;
  createdAt: string;
  appliedAt: string | null;
}

export interface HistoryEntry {
  id: number;
  proposalId: number;
  from: ProposalStatus | null;
  to: ProposalStatus;
  actor: Actor;
  reason: string;
  at: string;
}

/** Applies one pending command via the lifecycle. Used by the worker, the sole writer of status. */
export function applyCommand(store: Datastore, command: Command): void {
  if (command.type === "shortlist") store.transition(command.proposalId, "shortlisted", "operator", command.reason || undefined);
  else if (command.type === "approve") approve(store, command.proposalId, "operator", command.reason || undefined);
  else if (command.type === "dismiss") {
    if (!command.reason.trim()) throw new Error("Dismissal requires a reason");
    store.transition(command.proposalId, "dismissed", "operator", command.reason.trim());
  } else throw new Error(`Unknown command type ${String(command.type)}`);
}

/** Applies every pending command in order. Idempotent: applied and rejected commands are never re-run. */
export function applyPendingCommands(store: Datastore): number {
  let n = 0;
  for (const c of store.pendingCommands()) {
    store.resolveCommand(c.id, () => applyCommand(store, c));
    n++;
  }
  return n;
}
