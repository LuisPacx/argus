import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { buildHomeFor, removeTree } from "./build-runner.ts";
import type { Datastore, Proposal } from "./datastore.ts";

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
  { from: "build-failed", to: "approved", actor: "operator", reason: "Operator re-queued" },
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

export type CommandType = "shortlist" | "dismiss" | "approve" | "revise" | "retry-spec" | "requeue";
export type CommandStatus = "pending" | "applied" | "rejected" | "failed";

export interface Command {
  id: number;
  proposalId: number;
  type: CommandType;
  reason: string;
  status: CommandStatus;
  /** Rejection reason, or the last non-domain error while retrying or once `failed`. */
  error: string;
  /** Non-domain failures so far. */
  attempts: number;
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

const TARGET: Partial<Record<CommandType, ProposalStatus>> = {
  shortlist: "shortlisted",
  approve: "approved",
  requeue: "approved",
  dismiss: "dismissed",
};

/** What the worker lets a command touch outside the datastore. */
export interface ApplyOptions {
  /** argus's data dir. When set, dismissing a Proposal deletes its per-Build home (retention: kept for `build-failed`, gone on `built` and `dismissed`). */
  dataDir?: string;
  log?: (line: string) => void;
}

/**
 * How a re-queue finds out what a failed Build left behind: where the Build repos are (`~/code`) and how to ask GitHub whether the
 * Build's private repo exists (see `githubRepoCheck`). Both are required wherever commands are applied, so a re-queue is never let
 * through unchecked. They do I/O, so they run in `applyPendingCommands` before a transaction opens, never inside `applyCommand`.
 */
export interface RequeueChecks {
  buildRoot: string;
  githubRepoExists: (slug: string) => boolean;
}

/** What a failed Build left that the Operator must remove before a re-queue; empty when nothing blocks one. Does I/O: call it outside any transaction. */
export function requeueLeftovers(p: Proposal, checks: RequeueChecks): string[] {
  const left: string[] = [];
  const dir = resolve(checks.buildRoot, p.slug);
  if (existsSync(dir)) left.push(`the local directory ${dir}`);
  if (checks.githubRepoExists(p.slug)) left.push(`the private GitHub repo ${p.slug}`);
  // Named only with something else in the way: whether the Worker is still there is not asked of Cloudflare, and the fresh Build's
  // first step refuses a name that is taken.
  if (left.length > 0 && p.workerDeployed) left.push(`the Cloudflare Worker ${p.slug} (the Build deployed it)`);
  return left;
}

/**
 * Applies one pending command via the lifecycle. Used by the worker, the sole writer of status.
 * A command whose target status is already current is a no-op (a double-click is not an error).
 * Throws DomainError subclasses for commands that can never succeed.
 * Does no exec or network I/O (it runs inside a SQLite transaction): a re-queue needs `leftovers`, computed beforehand by
 * `requeueLeftovers`, and without them it fails closed rather than skipping the check.
 */
export function applyCommand(store: Datastore, command: Command, opts: ApplyOptions = {}, leftovers?: readonly string[]): void {
  const proposal = store.getProposal(command.proposalId);
  if (command.type === "revise" || command.type === "retry-spec") {
    if (!proposal) throw new ProposalNotFoundError(command.proposalId);
    if (command.type === "revise") reviseCommand(store, proposal, command.reason);
    else retrySpecCommand(store, proposal);
    return;
  }
  const target = TARGET[command.type];
  if (!target) throw new DomainError(`Unknown command type ${String(command.type)}`);
  if (!proposal) throw new ProposalNotFoundError(command.proposalId);
  const reason = command.reason.trim() || undefined;
  if (command.type === "dismiss" && !reason) throw new MissingReasonError();
  if (proposal.status === target) return;
  if (command.type === "approve" && (proposal.specRevision !== null || proposal.brainRunInFlightSince !== null)) {
    throw new DomainError("A Spec revision is pending or running; approve once it finishes");
  }
  // Two commands reach `approved`: approve (from spec-drafted) and requeue (from build-failed); neither stands in for the other.
  if (command.type === "approve" && proposal.status === "build-failed") throw new DomainError("A failed Build is re-queued, not approved");
  if (command.type === "requeue" && proposal.status !== "build-failed") throw new DomainError(`Re-queue needs a build-failed Proposal (it is ${proposal.status})`);
  if (command.type === "requeue") {
    // argus never deletes a Build's repos: a fresh Build needs the directory and the GitHub repo gone, so the Operator removes them first.
    if (leftovers === undefined) throw new Error("re-queue applied without its leftovers check");
    if (leftovers.length > 0) throw new DomainError(`Not re-queued: remove ${leftovers.join(", ")}, then re-queue. argus never deletes them.`);
  }
  if (command.type === "approve") approve(store, command.proposalId, "operator", reason);
  else if (command.type === "dismiss") {
    store.transition(command.proposalId, "dismissed", "operator", reason);
    // A Build that is running has its container on the home: the runner deletes it when that Build ends.
    if (opts.dataDir !== undefined && proposal.status !== "building") {
      const home = buildHomeFor(opts.dataDir, command.proposalId);
      const error = removeTree(home);
      if (error) opts.log?.(`[worker] could not remove ${home}: ${error}`);
    }
  } else store.transition(command.proposalId, target, "operator", reason);
}

/**
 * Applies every pending command in order and returns how many were resolved (applied or rejected).
 * A command that fails with a non-domain error stays pending (retried next tick, up to 5 attempts, then `failed`) and is reported to
 * `onError`; it never stops the rest of the batch.
 */
export function applyPendingCommands(store: Datastore, onError: ((command: Command, error: unknown) => void) | undefined, opts: ApplyOptions & RequeueChecks): number {
  let n = 0;
  for (const c of store.pendingCommands()) {
    try {
      // The slow checks (filesystem, `gh`) run here, before resolveCommand opens its write transaction. Only a re-queue of a
      // build-failed Proposal needs them; any other re-queue is refused by applyCommand before it needs them (and fails closed if the status moved to build-failed meanwhile). A check that cannot be
      // answered is thrown from inside resolveCommand so the attempt is counted like any other non-domain failure.
      let leftovers: readonly string[] | undefined;
      let checkError: unknown;
      if (c.type === "requeue") {
        const p = store.getProposal(c.proposalId);
        if (p?.status === "build-failed") {
          try {
            leftovers = requeueLeftovers(p, opts);
          } catch (e) {
            checkError = e;
          }
        }
      }
      store.resolveCommand(c.id, () => {
        if (checkError !== undefined) throw checkError;
        applyCommand(store, c, opts, leftovers);
      });
      n++;
    } catch (e) {
      onError?.(c, e);
    }
  }
  return n;
}

/** Longest revise instruction accepted. */
export const MAX_REVISE_INSTRUCTION_CHARS = 4000;

function reviseCommand(store: Datastore, p: Proposal, instruction: string): void {
  const text = instruction.trim();
  if (!text) throw new DomainError("Revise needs an instruction");
  if (text.length > MAX_REVISE_INSTRUCTION_CHARS) throw new DomainError(`Revise instruction is over ${MAX_REVISE_INSTRUCTION_CHARS} characters`);
  if (p.status !== "spec-drafted") throw new DomainError(`Revise needs a spec-drafted Proposal (it is ${p.status})`);
  if (p.brainRunInFlightSince !== null) throw new DomainError("A brain run is in flight for this Proposal; try again when it finishes");
  if (p.specRevision !== null) throw new DomainError("A revision is already queued");
  store.queueRevision(p.id, text);
}

/**
 * Retry a failed Spec draft: clears the error, attempt count and retry time so the next worker pass drafts again (a new
 * brain run, with its own cost). Refused while any brain run is in flight for the Proposal.
 */
function retrySpecCommand(store: Datastore, p: Proposal): void {
  if (p.brainRunInFlightSince !== null) throw new DomainError("A brain run is in flight for this Proposal; retry when it finishes");
  if (p.status !== "shortlisted" || !p.specError) throw new DomainError("Nothing to retry: this Proposal has no failed Spec draft");
  store.resetSpecFailure(p.id);
}
