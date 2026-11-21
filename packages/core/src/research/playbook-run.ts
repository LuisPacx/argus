import { BrainError, type Brain } from "../brain.ts";
import type { Datastore } from "../datastore.ts";
import { DEFAULT_RESEARCH_BUDGET_CONFIG, researchRunCaps, researchUsage, type ResearchBudgetConfig } from "../research-budget.ts";
import { PLAYBOOK_MAX_RUNS_PER_DAY, PLAYBOOK_MIN_PICKS, PLAYBOOK_RUN_MAX_USD, parsePlaybookOutput, playbookPromptFor, provenanceOf, tooFewMessage } from "./playbook.ts";

/**
 * The worker's Playbook step (human researcher ticket 09, ADR 0017): takes each pending `playbook_requests` row (written by the Operator's "Rebuild playbook"
 * button and nothing else) and makes a new Playbook version of it with ONE `playbook` Brain run:
 *  1. fewer than `PLAYBOOK_MIN_PICKS` finished Picks ends the request `refused` with the reason, before any cap is read or any run is opened;
 *  2. the caps: `PLAYBOOK_MAX_RUNS_PER_DAY` runs in 24 hours, then the shared research budget (a capped request ends `capped` with the reason);
 *  3. the run is opened in `brain_runs` before the child starts and its cost recorded the moment it returns, so it counts in the research budget;
 *  4. the answer must fit `parsePlaybookOutput`; a miss ends the request `failed` with the reason (a rebuild is one run, there is no retry);
 *  5. the version is stored with the ids of the Picks the run was shown and their settle cutoff, taken from the very rows in the prompt.
 * A rate limit, a shutdown or a dry run leaves the request waiting. Nothing here runs on a timer by itself: the worker calls it only when a request waits.
 */

const DAY_MS = 24 * 3_600_000;
const usd = (n: number): string => `$${n.toFixed(2)}`;

export interface PlaybookRunOptions {
  research?: ResearchBudgetConfig;
  now?: () => Date;
  log?: (line: string) => void;
  signal?: AbortSignal;
}

export interface PlaybookRunResult {
  /** Playbook runs started. */
  called: number;
  done: number;
  failed: number;
  capped: number;
  refused: number;
  stoppedBy?: "rate-limited" | "interrupted" | "dry-run";
}

export async function runPlaybookRequests(store: Datastore, brain: Brain, opts: PlaybookRunOptions = {}): Promise<PlaybookRunResult> {
  const out: PlaybookRunResult = { called: 0, done: 0, failed: 0, capped: 0, refused: 0 };
  const log = opts.log ?? console.log;
  const clock = opts.now ?? (() => new Date());
  const research = opts.research ?? DEFAULT_RESEARCH_BUDGET_CONFIG;
  const caps = researchRunCaps(brain);
  store.requeueRunningPlaybookRequests();

  for (const req of store.pendingPlaybookRequests()) {
    if (opts.signal?.aborted) return { ...out, stoppedBy: "interrupted" };
    const now = clock();
    const have = store.countFinishedPicks();
    if (have < PLAYBOOK_MIN_PICKS) {
      const why = tooFewMessage(have);
      log(`[worker] playbook: ${why}; request ${req.id} is refused, no model call`);
      store.resolvePlaybookRequest(req.id, { status: "refused", detail: why }, now);
      out.refused++;
      continue;
    }
    const since = new Date(now.getTime() - DAY_MS).toISOString();
    const spent = store.playbookSpendSince(since, caps);
    let capped: string | undefined;
    if (spent.runs >= PLAYBOOK_MAX_RUNS_PER_DAY) capped = `daily cap of ${PLAYBOOK_MAX_RUNS_PER_DAY} playbook rebuilds reached (${spent.runs} in 24 h)`;
    else {
      const usage = researchUsage(store, now, research, caps);
      if (usage.exhausted) capped = `research budget reached (${usd(usage.usedUsd)} of ${usd(usage.budgetUsd)} in 24 h, judge, propose, summaries, meme ideas, topic research and playbook together)`;
    }
    if (capped !== undefined) {
      log(`[worker] playbook: ${capped}; request ${req.id} is capped`);
      store.resolvePlaybookRequest(req.id, { status: "capped", detail: capped }, now);
      out.capped++;
      continue;
    }
    if (!store.claimPlaybookRequest(req.id)) continue;

    // What the run is shown, read once: the ids and the cutoff stored on the version are computed from these same rows.
    const picks = store.playbookPicks();
    const provenance = provenanceOf(picks);
    if (provenance === null || picks.length < PLAYBOOK_MIN_PICKS) {
      store.resolvePlaybookRequest(req.id, { status: "refused", detail: tooFewMessage(picks.length) }, clock());
      out.refused++;
      continue;
    }

    const runId = store.startBrainRun({ proposalId: 0, task: "playbook", ...brain.routeFor("playbook") }, clock());
    store.attachPlaybookRun(req.id, runId);
    out.called++;
    let result;
    try {
      // The per-run cap is the constant here: the Brain takes the lower of it and the route's, so a routing override cannot raise it.
      result = await brain.run<string>("playbook", { prompt: playbookPromptFor(picks) }, { signal: opts.signal, maxBudgetUsd: PLAYBOOK_RUN_MAX_USD, onBackend: (r) => store.setBrainRunBackend(runId, r.backend, r.model) });
    } catch (e) {
      const brainError = e instanceof BrainError ? e : undefined;
      const kind = brainError?.kind ?? "failed";
      store.finishBrainRun(runId, { sessionId: brainError?.sessionId ?? null, totalCostUsd: brainError?.totalCostUsd ?? 0, exitStatus: kind, backend: brainError?.backend, model: brainError?.model });
      if (kind === "interrupted") {
        store.releasePlaybookRequest(req.id);
        return { ...out, stoppedBy: "interrupted" };
      }
      if (kind === "rate-limited") {
        log("[worker] playbook: rate-limited; the request stays queued");
        store.releasePlaybookRequest(req.id);
        return { ...out, stoppedBy: "rate-limited" };
      }
      log(`[worker] playbook: request ${req.id} ${kind}`);
      store.resolvePlaybookRequest(req.id, { status: "failed", detail: kind === "budget-exceeded" ? `the run went over its budget of ${usd(PLAYBOOK_RUN_MAX_USD)}` : kind === "timed-out" ? "the run timed out" : "the run failed" }, clock());
      out.failed++;
      continue;
    }
    if (result.dryRun) {
      store.discardBrainRun(runId);
      out.called--;
      log("[worker] playbook: dry-run, nothing spawned; the request stays queued");
      store.releasePlaybookRequest(req.id);
      return { ...out, stoppedBy: "dry-run" };
    }
    const parsed = parsePlaybookOutput(result.output);
    store.finishBrainRun(runId, { sessionId: result.sessionId ?? null, totalCostUsd: result.totalCostUsd, exitStatus: parsed.ok ? "success" : "invalid-output", backend: result.backend, model: result.model });
    if (!parsed.ok) {
      log(`[worker] playbook: request ${req.id} refused the answer: ${parsed.problem}`);
      store.resolvePlaybookRequest(req.id, { status: "failed", detail: `the answer was refused: ${parsed.problem}` }, clock());
      out.failed++;
      continue;
    }
    const id = store.savePlaybookVersion(req.id, { text: parsed.text, pickIds: provenance.pickIds, settleCutoff: provenance.settleCutoff }, clock());
    if (id !== undefined) {
      out.done++;
      log(`[worker] playbook: request ${req.id} done, version ${id} from ${provenance.pickIds.length} Picks`);
    }
  }
  return out;
}
