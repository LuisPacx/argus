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
  { from: "spec-drafted", to: "approved", actor: "system", reason: "Score threshold" },
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

/**
 * A command that can never succeed as sent (illegal transition, unknown Proposal, missing reason).
 * Only these are recorded as a permanent rejection; any other error is transient and retried next tick.
 */
export class DomainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DomainError";
  }
}

export class IllegalTransitionError extends DomainError {
  constructor(from: ProposalStatus, to: ProposalStatus, actor: Actor) {
    super(`Illegal transition ${from} -> ${to} by ${actor}`);
    this.name = "IllegalTransitionError";
  }
}

export class ProposalNotFoundError extends DomainError {
  constructor(proposalId: number) {
    super(`Proposal ${proposalId} not found`);
    this.name = "ProposalNotFoundError";
  }
}

export class MissingReasonError extends DomainError {
  constructor(message = "Dismissal requires a reason") {
    super(message);
    this.name = "MissingReasonError";
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

const TARGET: Record<CommandType, ProposalStatus> = {
  shortlist: "shortlisted",
  approve: "approved",
  dismiss: "dismissed",
};

/**
 * Applies one pending command via the lifecycle. Used by the worker, the sole writer of status.
 * A command whose target status is already current is a no-op (a double-click is not an error).
 * Throws DomainError subclasses for commands that can never succeed.
 */
export function applyCommand(store: Datastore, command: Command): void {
  const target = TARGET[command.type];
  if (!target) throw new DomainError(`Unknown command type ${String(command.type)}`);
  const proposal = store.getProposal(command.proposalId);
  if (!proposal) throw new ProposalNotFoundError(command.proposalId);
  if (proposal.status === target) return;
  const reason = command.reason.trim() || undefined;
  if (command.type === "approve") approve(store, command.proposalId, "operator", reason);
  else if (command.type === "dismiss") {
    if (!reason) throw new MissingReasonError();
    store.transition(command.proposalId, "dismissed", "operator", reason);
  } else store.transition(command.proposalId, target, "operator", reason);
}

/**
 * Applies every pending command in order and returns how many were resolved (applied or rejected).
 * A command that fails with a non-domain error stays pending (retried next tick) and is reported to
 * `onError`; it never stops the rest of the batch.
 */
export function applyPendingCommands(store: Datastore, onError?: (command: Command, error: unknown) => void): number {
  let n = 0;
  for (const c of store.pendingCommands()) {
    try {
      store.resolveCommand(c.id, () => applyCommand(store, c));
      n++;
    } catch (e) {
      onError?.(c, e);
    }
  }
  return n;
}
