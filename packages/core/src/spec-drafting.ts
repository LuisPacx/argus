import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { BrainError, type Brain } from "./brain.ts";
import type { Datastore, Proposal } from "./datastore.ts";

/** How long a rate-limited draft waits before the worker tries again. */
export const RATE_LIMIT_BACKOFF_MS = 15 * 60_000;

export function specPromptFor(p: Proposal): string {
  return [
    `Proposal: ${p.name} (${p.ticker})`,
    `Narrative: ${p.narrativeSummary}`,
    `Tech: ${p.techOneLiner}`,
    `Why now: ${p.whyNow}`,
    `Description: ${p.description}`,
    `Evidence: ${p.evidenceLinks.join(", ") || "none"}`,
  ].join("\n");
}

export function specPathFor(dataDir: string, proposalId: number): string {
  return join(dataDir, "proposals", String(proposalId), "spec.md");
}

/** Shortlisted Proposals that still need a Spec and are not waiting out a failure. */
export function draftable(store: Datastore, now = new Date()): Proposal[] {
  return store.listProposals().filter((p) => {
    if (p.status !== "shortlisted") return false;
    if (!p.specError) return true;
    return p.specRetryAfter !== null && new Date(p.specRetryAfter) <= now;
  });
}

/**
 * Drafts the Spec for one shortlisted Proposal. On success writes `spec.md`, stores path and hash and
 * moves to `spec-drafted`. On failure the Proposal stays `shortlisted` with `specError` set.
 * Returns true when a Spec was drafted.
 */
export async function draftSpec(store: Datastore, brain: Brain, proposal: Proposal, dataDir: string): Promise<boolean> {
  try {
    const run = await brain.run<string>("spec", { prompt: specPromptFor(proposal) });
    if (run.dryRun) return false;
    const text = run.output.trim();
    if (!text) throw new Error("Brain returned an empty Spec");
    const path = specPathFor(dataDir, proposal.id);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text + "\n");
    const hash = createHash("sha256").update(text + "\n").digest("hex");
    store.completeSpec(
      proposal.id,
      { path, hash },
      {
        proposalId: proposal.id,
        task: "spec",
        backend: run.backend,
        model: run.model,
        sessionId: run.sessionId ?? null,
        totalCostUsd: run.totalCostUsd,
        exitStatus: "success",
      },
    );
    return true;
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (e instanceof BrainError) {
      const retryAfter = e.kind === "rate-limited" ? new Date(Date.now() + RATE_LIMIT_BACKOFF_MS).toISOString() : undefined;
      store.failSpec(
        proposal.id,
        `Spec draft ${e.kind}: ${message}`,
        {
          proposalId: proposal.id,
          task: "spec",
          backend: e.backend,
          model: e.model,
          sessionId: e.sessionId ?? null,
          totalCostUsd: e.totalCostUsd,
          exitStatus: e.kind,
        },
        retryAfter,
      );
    } else {
      store.failSpec(proposal.id, `Spec draft failed: ${message}`);
    }
    return false;
  }
}

/** One worker pass: draft every eligible shortlisted Proposal in order. */
export async function draftPendingSpecs(
  store: Datastore,
  brain: Brain,
  dataDir: string,
  log: (line: string) => void = console.log,
): Promise<number> {
  let n = 0;
  for (const p of draftable(store)) {
    const ok = await draftSpec(store, brain, p, dataDir);
    log(`[worker] spec for proposal ${p.id}: ${ok ? "drafted" : "not drafted"}`);
    if (ok) n++;
  }
  return n;
}
