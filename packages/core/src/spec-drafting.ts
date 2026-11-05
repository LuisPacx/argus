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

const NEEDS_HUMAN = /^## Needs human[ \t]*$/im;
const ANY_HEADING = /^#{1,2} \S/gm;

/** Sections `.claude/skills/spec/SKILL.md` requires of a full Spec, besides the H1 title. */
export const REQUIRED_SPEC_HEADINGS = ["Goal", "Scope", "Acceptance criteria"] as const;

/**
 * Whether `text` is a Spec, per the `spec` skill's output contract. Returns the problem, or null when valid. Valid is
 * exactly one of:
 * - a full Spec: the first line is an H1 (`# <Name>`) and the document has `## Goal`, `## Scope` and
 *   `## Acceptance criteria` headings;
 * - a refusal in the skill's own form: the first line is `## Needs human`, with an explanation and no other H1/H2.
 * Anything else (a model saying it has no tool, a preamble, a code-fenced document) is not a Spec.
 */
export function specProblem(text: string): string | null {
  const lines = text.trim().split("\n");
  const first = lines[0] ?? "";
  if (NEEDS_HUMAN.test(first)) {
    if (lines.length < 2 || !lines.slice(1).join("").trim()) return "`## Needs human` section has no explanation";
    if ((text.match(ANY_HEADING) ?? []).length > 1) return "`## Needs human` must be the only section";
    return null;
  }
  if (!/^# \S/.test(first)) return `does not start with a \`# <Name>\` title (starts with: ${JSON.stringify(first.slice(0, 80))})`;
  const missing = REQUIRED_SPEC_HEADINGS.filter((h) => !new RegExp(`^## ${h}[ \\t]*$`, "im").test(text));
  return missing.length > 0 ? `missing required section(s): ${missing.map((h) => `## ${h}`).join(", ")}` : null;
}

/** Shortlisted Proposals that still need a Spec: not waiting out a failure and with no brain run open. */
export function draftable(store: Datastore, now = new Date()): Proposal[] {
  return store.listProposals().filter((p) => {
    if (p.status !== "shortlisted") return false;
    if (p.brainRunInFlightSince !== null) return false;
    if (!p.specError) return true;
    return p.specRetryAfter !== null && new Date(p.specRetryAfter) <= now;
  });
}

/**
 * Drafts the Spec for one shortlisted Proposal. Returns true when a Spec was drafted.
 *
 * Spend is never lost or doubled:
 * - an `in-flight` brain_runs row is inserted before the child is spawned, and a Proposal with one open is never
 *   re-drafted (a crash leaves it behind; the next worker boot marks it `interrupted` and shows it on the card);
 * - the run's cost, session and exit status are recorded the moment `brain.run` returns, before any file write or
 *   transition, so a later throw cannot lose them;
 * - the Proposal is re-read afterwards: if it is no longer `shortlisted` (dismissed mid-run) the run is recorded and
 *   nothing else happens: no file, no `specError`, no transition;
 * - any failure after the run is recorded sets `specError` with no retry time, so it is never re-drafted.
 */
export async function draftSpec(
  store: Datastore,
  brain: Brain,
  proposal: Proposal,
  dataDir: string,
  signal?: AbortSignal,
): Promise<boolean> {
  if (signal?.aborted) return false; // shutting down: never spawn
  const current = store.getProposal(proposal.id);
  if (!current || current.status !== "shortlisted") return false;
  if (store.openBrainRun(proposal.id, "spec")) return false;

  const runId = store.startBrainRun({ proposalId: proposal.id, task: "spec", ...brain.routeFor("spec") });
  let run;
  try {
    run = await brain.run<string>("spec", { prompt: specPromptFor(proposal) }, { signal });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const brainError = e instanceof BrainError ? e : undefined;
    store.finishBrainRun(runId, {
      sessionId: brainError?.sessionId ?? null,
      totalCostUsd: brainError?.totalCostUsd ?? 0,
      exitStatus: brainError?.kind ?? "failed",
    });
    // Killed by shutdown: not a verdict on the Proposal. Leave it shortlisted with no error so the next boot drafts it again.
    if (brainError?.kind === "interrupted") return false;
    if (store.getProposal(proposal.id)?.status === "shortlisted") {
      store.failSpec(proposal.id, `Spec draft ${brainError?.kind ?? "failed"}: ${message}`, {
        rateLimited: brainError?.kind === "rate-limited",
        backoffMs: RATE_LIMIT_BACKOFF_MS,
      });
    }
    return false;
  }
  if (run.dryRun) {
    store.discardBrainRun(runId);
    return false;
  }
  const text = run.output.trim();
  const problem = text ? specProblem(text) : "output is empty";
  store.finishBrainRun(runId, {
    sessionId: run.sessionId ?? null,
    totalCostUsd: run.totalCostUsd,
    exitStatus: problem ? "invalid-output" : "success",
  });

  // The spend is recorded. Nothing below may call the brain again.
  try {
    if (store.getProposal(proposal.id)?.status !== "shortlisted") return false;
    if (problem) {
      store.failSpec(proposal.id, `Spec draft invalid: ${problem}. Output not saved: ${JSON.stringify(text.slice(0, 200))}`);
      return false;
    }
    const path = specPathFor(dataDir, proposal.id);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text + "\n");
    const hash = createHash("sha256").update(text + "\n").digest("hex");
    store.completeSpec(proposal.id, { path, hash });
    return true;
  } catch (e) {
    if (store.getProposal(proposal.id)?.status === "shortlisted") {
      store.failSpec(proposal.id, `Spec draft failed after the run was recorded: ${e instanceof Error ? e.message : String(e)}`);
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
  signal?: AbortSignal,
): Promise<number> {
  let n = 0;
  for (const p of draftable(store)) {
    if (signal?.aborted) break; // shutting down: leave the rest for the next boot
    const ok = await draftSpec(store, brain, p, dataDir, signal);
    log(`[worker] spec for proposal ${p.id}: ${ok ? "drafted" : "not drafted"}`);
    if (ok) n++;
  }
  return n;
}
