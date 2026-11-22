import { BrainError, type Brain } from "../brain.ts";
import type { Datastore } from "../datastore.ts";
import { MOMENT_CONFIG } from "../moments/config.ts";
import type { MomentRunner } from "../moments/scan-runner.ts";
import { cleanLine } from "../meme/ideas.ts";
import { deadTokenNotes } from "../meme/live-token.ts";
import { DEFAULT_RESEARCH_BUDGET_CONFIG, researchRunCaps, researchUsage, type ResearchBudgetConfig } from "../research-budget.ts";
import { DexTruncatedError, type DexPair } from "../sources/dexscreener.ts";
import type { Notifier } from "../telegram.ts";
import { BRIEF_LIMITS, parseBriefOutput, RESEARCH_MAX_DAILY_USD, RESEARCH_MAX_RUNS_PER_DAY, RESEARCH_RUN_MAX_USD, researchPromptFor, type BriefCoin, type FreeName, type PromptCandidate, type ResearchBrief, type ResearchRequest } from "./brief.ts";
import { cleanTopic, decideBonded, snapshotFromPairs } from "./picks.ts";
import { eligiblePlaybook, type PlaybookSource, type ShadowPickInput } from "./shadow.ts";
import { parseTermsOutput, researchTermsPromptFor, RESEARCH_TERMS_RUN_MAX_USD, searchTerms } from "./terms.ts";
import { matchLocal, mergeCandidates, topLiteral, type LocalMatch } from "./widen.ts";
import { readXForTopic } from "./x-read.ts";

/**
 * The worker's research step (human researcher ticket 05, ADR 0017): takes each pending `research_requests` row and makes a Research brief of it.
 * Argus does the lookups by code; the model only reads the open web and writes the brief:
 *  1. the caps are checked first (6 runs a day, $3 a day, the shared research budget): a capped request ends `capped` with the reason and is never left waiting;
 *  2. DexScreener is searched for the topic (the declared client; a failure ends the request `failed` before any money is spent). The tokens Argus saw
 *     migrate in the last 7 days are matched against the terms in code and merged in (`widen.ts`, research widen ticket 01): extras only when bonded;
 *     Between the two sits the terms step (research widen ticket 02): one `research-terms` Brain run (Haiku, no tools, at most $0.05, after the cap check, a dry
 *     run skips it) turns the topic into up to 15 related terms; they join the local match and up to 8 of them are searched on DexScreener one by one (a failure
 *     keeps the hits so far). A terms run that fails or gives nothing valid never fails the brief: the topic alone is used and the brief's note says so.
 *  3. X is read through the scanner's child process and its session gate, or not at all (the note says why);
 *  4. one `researcher` run is opened in `brain_runs` before the child starts and its cost recorded the moment it returns;
 *  5. the answer must fit `parseBriefOutput`; a miss goes back once with the exact error, a second miss ends the request `failed` with the reason;
 *  6. the coins in the brief are the model's chosen candidates with cap and bonded state taken from DexScreener by code, and each free name is checked
 *     against DexScreener (a name a live token uses is dropped);
 *  7. the same answer holds the Shadow picks (ticket 08): at most two of its own coins, which `parseBriefOutput` refuses otherwise (so a coin outside the list
 *     ends in the repair retry). They are snapshotted from the complete DexScreener answer, stamped with the moment they are made, and written in the same
 *     transaction as the brief. The prompt holds nothing of the Operator's Picks; its one Operator-derived input is the Playbook version `eligiblePlaybook`
 *     lets through (settled before the request started), whose id is recorded on each Shadow pick. Nothing else in the repo writes a Shadow pick.
 * A rate limit, a shutdown or a dry run leaves the request waiting for the next pass. Nothing here launches, signs or spends anything (ADR 0002).
 */

const DAY_MS = 24 * 3_600_000;
/** Requests served in one pass; the rest wait for the next tick. */
const MAX_PER_PASS = 2;
const LOOKUP_BATCH = 30;
/** The local set is the tokens that migrated within this many days (the Study keeps about 13 days, with gaps). */
const LOCAL_DAYS = 7;
/** Most tokens read from the Study in one request (a week of migrations is a few thousand), and most matches looked up on DexScreener (newest first). */
const LOCAL_READ_MAX = 20_000;
const LOCAL_LOOKUP_MAX = 60;

/** The DexScreener methods the step needs; `DexScreenerClient` satisfies it, tests pass a fake. */
export interface ResearchDex {
  search(query: string): Promise<DexPair[]>;
  tokenPairs(chainId: string, addresses: string[], opts?: { failIfTruncated?: boolean }): Promise<DexPair[]>;
}

export interface ResearchOptions {
  dex: ResearchDex;
  /** The scanner's child process, as the worker wires it. Absent, X is not read. */
  xRunner?: MomentRunner;
  notifier?: Pick<Notifier, "notify">;
  research?: ResearchBudgetConfig;
  /** The shared daily cap on X page loads (the scanner's setting). */
  xLoadsPerDay?: number;
  /** Where Playbook versions come from (ticket 09). Absent, no Playbook is read and every Shadow pick records "none". */
  playbook?: PlaybookSource;
  now?: () => Date;
  log?: (line: string) => void;
  signal?: AbortSignal;
}

export interface ResearchResult {
  /** Researcher runs started (the repair retry included). */
  called: number;
  done: number;
  failed: number;
  capped: number;
  stoppedBy?: "rate-limited" | "interrupted" | "dry-run";
}

const usd = (n: number): string => `$${n.toFixed(2)}`;

/**
 * The coins DexScreener listed for the topic that the model may choose from: Solana only, a plain address, priced, one per token (its deepest pair),
 * biggest market cap first (unknown last), at most `RESEARCH_LITERAL_MAX` (15): the literal search's share of the candidates. `mergeCandidates` (`widen.ts`)
 * builds the list the model sees (up to `RESEARCH_CANDIDATES_MAX`, with the bonded local coins). The model is shown ids (`c1`, `c2`, ...), never addresses.
 */
export function pickCandidates(pairs: readonly DexPair[]): { id: string; pair: DexPair }[] {
  return topLiteral(pairs).map((pair, i) => ({ id: `c${i + 1}`, pair }));
}

/** The terms the local set is matched against: the topic itself, then the terms the model gave (research widen ticket 02; `parseTermsOutput` has dropped repeats of the topic). */
function termsFor(topic: string, extra: readonly string[] = []): string[] {
  return [topic, ...extra];
}

/**
 * The local bonded set (research widen ticket 01): the tokens Argus itself saw migrate in the last 7 days, matched against `terms` in plain code, then looked up
 * on DexScreener (the newest `LOCAL_LOOKUP_MAX` matches) for their market cap and liquidity. A match DexScreener cannot answer for is left out. Never throws:
 * a failed read or lookup only means fewer coins. Returns the extra pairs, each with its term, and the complete answers (the chosen coins reuse them).
 */
async function localExtras(store: Datastore, dex: ResearchDex, terms: readonly string[], now: Date, log: (line: string) => void): Promise<{ extras: { pair: DexPair; via: string }[]; complete: Map<string, DexPair[]> }> {
  const complete = new Map<string, DexPair[]>();
  const extras: { pair: DexPair; via: string }[] = [];
  let matches: LocalMatch[];
  try {
    matches = matchLocal(terms, store.study.migratedSince(new Date(now.getTime() - LOCAL_DAYS * DAY_MS).toISOString(), LOCAL_READ_MAX)).slice(0, LOCAL_LOOKUP_MAX);
  } catch (e) {
    log(`[worker] research: the local migrated set could not be read, so it is left out: ${e instanceof Error ? e.message : String(e)}`);
    return { extras, complete };
  }
  if (matches.length === 0) return { extras, complete };
  const answers = await completePairs(dex, matches.map((m) => m.token.mint));
  for (const [ca, pairs] of answers) complete.set(ca, pairs);
  for (const m of matches) for (const p of answers.get(m.token.mint) ?? []) extras.push({ pair: p, via: m.via });
  return { extras, complete };
}

/** One lookup per batch of coins; a batch the client says may be cut is split in half and asked again, so a cut answer never decides a coin. A failed batch leaves its coins out. */
async function completePairs(dex: ResearchDex, cas: string[]): Promise<Map<string, DexPair[]>> {
  const answers = new Map<string, DexPair[]>();
  const lookup = async (chunk: string[]): Promise<void> => {
    try {
      const pairs = await dex.tokenPairs("solana", chunk, { failIfTruncated: true });
      for (const ca of chunk) answers.set(ca, pairs.filter((x) => x.tokenAddress === ca));
    } catch (e) {
      if (!(e instanceof DexTruncatedError) || chunk.length === 1) return;
      const mid = Math.ceil(chunk.length / 2);
      await lookup(chunk.slice(0, mid));
      await lookup(chunk.slice(mid));
    }
  };
  for (let i = 0; i < cas.length; i += LOOKUP_BATCH) await lookup(cas.slice(i, i + LOOKUP_BATCH));
  return answers;
}

/** A coin of the brief: name, cap and liquidity from DexScreener, bonded state by `decideBonded` over the complete pairs (`unknown` when they could not be had). */
function coinOf(ca: string, listed: DexPair, complete: DexPair[] | undefined, migratedAt: string | null, note: string): BriefCoin {
  const usable = (complete ?? []).filter((p) => p.unpriced !== true);
  const deepest = usable.length > 0 ? usable.reduce((a, b) => (b.liquidityUsd > a.liquidityUsd ? b : a)) : listed;
  const cap = deepest.marketCapUsd !== undefined && deepest.marketCapUsd > 0 ? deepest.marketCapUsd : null;
  let bonded: BriefCoin["bonded"] = "unknown";
  if (complete !== undefined) bonded = decideBonded(ca, usable, migratedAt).bonded ? "yes" : "no";
  else if (migratedAt !== null) bonded = "yes";
  return { ca, name: cleanLine(deepest.name, 60), symbol: cleanLine(deepest.symbol, 20), marketCapUsd: cap, liquidityUsd: deepest.liquidityUsd, bonded, note };
}

export async function runResearchRequests(store: Datastore, brain: Brain, opts: ResearchOptions): Promise<ResearchResult> {
  const out: ResearchResult = { called: 0, done: 0, failed: 0, capped: 0 };
  const log = opts.log ?? console.log;
  const clock = opts.now ?? (() => new Date());
  const research = opts.research ?? DEFAULT_RESEARCH_BUDGET_CONFIG;
  const caps = researchRunCaps(brain);
  // A request a dead worker left `running` is waiting again (the step is re-entrancy guarded, so none is running now).
  store.requeueRunningResearchRequests();

  /** Whether another researcher run may start: its own two daily caps, then the shared research budget. A reason when not. */
  const capReason = (now: Date): string | undefined => {
    const spent = store.researcherSpendSince(new Date(now.getTime() - DAY_MS).toISOString(), caps);
    if (spent.runs >= RESEARCH_MAX_RUNS_PER_DAY) return `daily cap of ${RESEARCH_MAX_RUNS_PER_DAY} research runs reached (${spent.runs} in 24 h, ${usd(spent.chargedUsd)})`;
    if (spent.chargedUsd >= RESEARCH_MAX_DAILY_USD) return `daily research spend cap of ${usd(RESEARCH_MAX_DAILY_USD)} reached (${usd(spent.chargedUsd)} in 24 h)`;
    const usage = researchUsage(store, now, research, caps);
    if (usage.exhausted) return `research budget reached (${usd(usage.usedUsd)} of ${usd(usage.budgetUsd)} in 24 h, judge, propose, summaries, meme ideas and topic research together)`;
    return undefined;
  };

  type Asked = { kind: "ok"; runId: number; output: string; costUsd: number; backend: string; model: string; sessionId: string | null } | { kind: "stop"; stoppedBy: NonNullable<ResearchResult["stoppedBy"]> } | { kind: "failed"; detail: string };

  /** One researcher run: an in-flight row first (linked to the request), the cost recorded the moment it returns. */
  const ask = async (req: ResearchRequest, prompt: string): Promise<Asked> => {
    const runId = store.startBrainRun({ proposalId: 0, task: "researcher", ...brain.routeFor("researcher") }, clock());
    store.attachResearchRun(req.id, runId);
    out.called++;
    let result;
    try {
      // The per-run cap is the constant here: the Brain takes the lower of it and the route's, so a routing override cannot raise it.
      result = await brain.run<string>("researcher", { prompt }, { signal: opts.signal, maxBudgetUsd: RESEARCH_RUN_MAX_USD, onBackend: (r) => store.setBrainRunBackend(runId, r.backend, r.model) });
    } catch (e) {
      const brainError = e instanceof BrainError ? e : undefined;
      const kind = brainError?.kind ?? "failed";
      store.finishBrainRun(runId, { sessionId: brainError?.sessionId ?? null, totalCostUsd: brainError?.totalCostUsd ?? 0, exitStatus: kind, backend: brainError?.backend, model: brainError?.model });
      if (kind === "interrupted") return { kind: "stop", stoppedBy: "interrupted" };
      if (kind === "rate-limited") {
        log("[worker] research: rate-limited; the request stays queued");
        return { kind: "stop", stoppedBy: "rate-limited" };
      }
      log(`[worker] research: request ${req.id} ${kind}`);
      const why = kind === "budget-exceeded" ? `the run went over its budget of ${usd(RESEARCH_RUN_MAX_USD)}` : kind === "timed-out" ? "the run timed out" : "the run failed";
      return { kind: "failed", detail: why };
    }
    if (result.dryRun) {
      store.discardBrainRun(runId);
      out.called--;
      log("[worker] research: dry-run, nothing spawned; the request stays queued");
      return { kind: "stop", stoppedBy: "dry-run" };
    }
    return { kind: "ok", runId, output: result.output, costUsd: result.totalCostUsd, backend: result.backend, model: result.model, sessionId: result.sessionId ?? null };
  };

  type TermsAsked = { kind: "ok"; terms: string[] } | { kind: "none"; why: string } | { kind: "stop"; stoppedBy: NonNullable<ResearchResult["stoppedBy"]> };

  /**
   * The terms step (research widen ticket 02): one `research-terms` run, opened in `brain_runs` before the child starts (so it counts in the research spend and the
   * shared budget), tied to the request, its cost recorded the moment it returns. A rate limit, a shutdown or a dry run stop the pass like the researcher's own;
   * any other miss (a failed, timed-out or over-budget run, an answer `parseTermsOutput` refuses, no term left) is `none`: the request goes on with the topic alone.
   */
  const askTerms = async (req: ResearchRequest): Promise<TermsAsked> => {
    const runId = store.startBrainRun({ proposalId: 0, task: "research-terms", ...brain.routeFor("research-terms") }, clock());
    store.attachResearchRun(req.id, runId);
    let result;
    try {
      // The per-run cap is the constant here: the Brain takes the lower of it and the route's, so a routing override cannot raise it.
      result = await brain.run<string>("research-terms", { prompt: researchTermsPromptFor(req.topic) }, { signal: opts.signal, maxBudgetUsd: RESEARCH_TERMS_RUN_MAX_USD, onBackend: (r) => store.setBrainRunBackend(runId, r.backend, r.model) });
    } catch (e) {
      const brainError = e instanceof BrainError ? e : undefined;
      const kind = brainError?.kind ?? "failed";
      store.finishBrainRun(runId, { sessionId: brainError?.sessionId ?? null, totalCostUsd: brainError?.totalCostUsd ?? 0, exitStatus: kind, backend: brainError?.backend, model: brainError?.model });
      if (kind === "interrupted") return { kind: "stop", stoppedBy: "interrupted" };
      if (kind === "rate-limited") {
        log("[worker] research: rate-limited at the terms step; the request stays queued");
        return { kind: "stop", stoppedBy: "rate-limited" };
      }
      log(`[worker] research: request ${req.id}: the terms run ${kind}; the topic alone is searched`);
      return { kind: "none", why: kind === "budget-exceeded" ? `the terms run went over its budget of ${usd(RESEARCH_TERMS_RUN_MAX_USD)}` : kind === "timed-out" ? "the terms run timed out" : "the terms run failed" };
    }
    if (result.dryRun) {
      store.discardBrainRun(runId);
      log("[worker] research: dry-run, no terms run spawned; the request stays queued");
      return { kind: "stop", stoppedBy: "dry-run" };
    }
    const parsed = parseTermsOutput(result.output, req.topic);
    store.finishBrainRun(runId, { sessionId: result.sessionId ?? null, totalCostUsd: result.totalCostUsd, exitStatus: parsed.ok ? "success" : "invalid-output", backend: result.backend, model: result.model });
    if (!parsed.ok) {
      log(`[worker] research: request ${req.id}: the research-terms answer was refused (${parsed.problem}); the topic alone is searched`);
      return { kind: "none", why: "the terms answer was refused" };
    }
    if (parsed.terms.length === 0) return { kind: "none", why: "the terms step gave no usable term" };
    return { kind: "ok", terms: parsed.terms };
  };

  let served = 0;
  for (const req of store.pendingResearchRequests()) {
    if (opts.signal?.aborted) return { ...out, stoppedBy: "interrupted" };
    if (served >= MAX_PER_PASS) break;
    const now = clock();
    const capped = capReason(now);
    if (capped !== undefined) {
      log(`[worker] research: ${capped}; request ${req.id} is capped`);
      store.resolveResearchRequest(req.id, { status: "capped", detail: capped }, now);
      out.capped++;
      continue;
    }
    if (store.claimResearchRequest(req.id) === undefined) continue;
    served++;
    const fail = (detail: string) => {
      store.resolveResearchRequest(req.id, { status: "failed", detail }, clock());
      out.failed++;
    };

    // What argus looks up by code, before any money is spent.
    let listed: DexPair[];
    try {
      listed = await opts.dex.search(req.topic);
    } catch (e) {
      log(`[worker] research: DexScreener search failed for request ${req.id}: ${e instanceof Error ? e.message : String(e)}`);
      fail("DexScreener could not be reached, so nothing was researched and nothing was spent; ask again");
      continue;
    }
    // The terms step, after the caps and the literal search and before the researcher run; a miss goes on with the topic alone and says so in the brief's note.
    const asked = await askTerms(req);
    if (asked.kind === "stop") {
      store.releaseResearchRequest(req.id);
      return { ...out, stoppedBy: asked.stoppedBy };
    }
    const terms = asked.kind === "ok" ? asked.terms : [];
    const termsNote = asked.kind === "none" ? `${asked.why}, so the topic alone was used` : "";
    const searched = await searchTerms(opts.dex, terms, log);
    const local = await localExtras(store, opts.dex, termsFor(req.topic, terms), now, log);
    const candidates = mergeCandidates({ topic: req.topic, literal: listed, extras: [...local.extras, ...searched.extras], migratedAt: (ca) => store.migrationOf(ca) });
    const x = await readXForTopic(req.topic, { store, runner: opts.xRunner, notifier: opts.notifier, loadsPerDay: opts.xLoadsPerDay ?? MOMENT_CONFIG.loadsPerDayDefault, now: clock, signal: opts.signal, log });
    if (opts.signal?.aborted) {
      store.releaseResearchRequest(req.id);
      return { ...out, stoppedBy: "interrupted" };
    }
    const promptCandidates: PromptCandidate[] = candidates.map(({ id, pair, bonded, via }) => ({
      id,
      bonded,
      via,
      name: pair.name,
      symbol: pair.symbol,
      marketCapUsd: pair.marketCapUsd !== undefined && pair.marketCapUsd > 0 ? pair.marketCapUsd : null,
      liquidityUsd: pair.liquidityUsd,
      ageMinutes: pair.pairCreatedAt !== undefined ? Math.max(0, Math.floor((now.getTime() - pair.pairCreatedAt) / 60_000)) : null,
    }));
    const ids = candidates.map((c) => c.id);
    // The leak guard: only a Playbook version built from Picks that settled before this request started (the Operator pressed the button), chosen once for both tries.
    const playbook = eligiblePlaybook(opts.playbook, (ids) => store.pickSettledAt(ids), new Date(req.createdAt));
    const promptFor = (retryProblem?: string) => researchPromptFor({ topic: req.topic, candidates: promptCandidates, posts: x.posts, xNote: x.note, ...(playbook !== null ? { playbook: { id: playbook.id, text: playbook.text } } : {}), ...(retryProblem !== undefined ? { retryProblem } : {}) });

    const first = await ask(req, promptFor());
    if (first.kind === "stop") {
      store.releaseResearchRequest(req.id);
      return { ...out, stoppedBy: first.stoppedBy };
    }
    if (first.kind === "failed") {
      fail(first.detail);
      continue;
    }
    let parsed = parseBriefOutput(first.output, ids);
    store.finishBrainRun(first.runId, { sessionId: first.sessionId, totalCostUsd: first.costUsd, exitStatus: parsed.ok ? "success" : "invalid-output", backend: first.backend, model: first.model });
    if (!parsed.ok) {
      log(`[worker] research: request ${req.id} refused: ${parsed.problem}`);
      // One repair retry, under the same caps: the exact error goes back, nothing else.
      const retryCap = capReason(clock());
      if (retryCap !== undefined) {
        store.resolveResearchRequest(req.id, { status: "capped", detail: `the answer was refused (${parsed.problem}) and ${retryCap} stopped the retry` }, clock());
        out.capped++;
        continue;
      }
      const second = await ask(req, promptFor(parsed.problem));
      if (second.kind === "stop") {
        store.releaseResearchRequest(req.id);
        return { ...out, stoppedBy: second.stoppedBy };
      }
      if (second.kind === "failed") {
        fail(`the answer was refused (${parsed.problem}) and the retry failed: ${second.detail}`);
        continue;
      }
      parsed = parseBriefOutput(second.output, ids);
      store.finishBrainRun(second.runId, { sessionId: second.sessionId, totalCostUsd: second.costUsd, exitStatus: parsed.ok ? "success" : "invalid-output", backend: second.backend, model: second.model });
      if (!parsed.ok) {
        fail(`the answer was refused twice: ${parsed.problem}`);
        continue;
      }
    }

    // The brief: the model's words for the story, sources and notes; DexScreener's numbers for the coins, by code.
    const chosen = parsed.brief.coins.flatMap((c) => {
      const cand = candidates.find((k) => k.id === c.id);
      return cand ? [{ cand, note: c.note }] : [];
    });
    // The coins found locally were looked up already: only the others are asked for.
    const complete = new Map(local.complete);
    const toLookUp = chosen.map((c) => c.cand.pair.tokenAddress).filter((ca) => !complete.has(ca));
    if (toLookUp.length > 0) for (const [ca, pairs] of await completePairs(opts.dex, toLookUp)) complete.set(ca, pairs);
    const coins = chosen
      .map(({ cand, note }) => coinOf(cand.pair.tokenAddress, cand.pair, complete.get(cand.pair.tokenAddress), store.migrationOf(cand.pair.tokenAddress), note))
      .sort((a, b) => (b.marketCapUsd ?? -1) - (a.marketCapUsd ?? -1))
      .slice(0, BRIEF_LIMITS.coins);
    const freeNames: FreeName[] = [];
    for (const n of parsed.brief.freeNames) {
      try {
        const found = deadTokenNotes({ name: n.name, ticker: n.ticker }, [...listed, ...(await opts.dex.search(n.name)), ...(await opts.dex.search(n.ticker))]);
        if (found.live.length === 0) freeNames.push({ name: n.name, ticker: n.ticker, why: n.why, note: found.note ?? "" });
      } catch (e) {
        log(`[worker] research: could not check the name "${cleanLine(n.name, 40)}" on DexScreener, so it is left out: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    // The Shadow picks, made now: each from the complete DexScreener answer for its coin (a coin whose lookup failed or was cut is not guessed, it is skipped).
    const madeAt = clock();
    const shadow: ShadowPickInput[] = [];
    for (const k of parsed.brief.picks) {
      const cand = candidates.find((c) => c.id === k.id);
      const pairs = cand ? complete.get(cand.pair.tokenAddress) : undefined;
      if (!cand || pairs === undefined) {
        log(`[worker] research: request ${req.id}: no complete DexScreener answer for pick ${k.id}, so it is not recorded`);
        continue;
      }
      const snap = snapshotFromPairs(cand.pair.tokenAddress, pairs, madeAt, store.migrationOf(cand.pair.tokenAddress));
      if (!snap.ok) {
        log(`[worker] research: request ${req.id}: pick ${k.id} not recorded: ${snap.message}`);
        continue;
      }
      shadow.push({ snapshot: snap.snapshot, reason: cleanLine(k.reason, BRIEF_LIMITS.pickReason), topic: cleanTopic(req.topic), playbookVersion: playbook?.id ?? null });
    }
    const brief: ResearchBrief = { story: parsed.brief.story, sources: parsed.brief.sources, coins, freeNames, xNote: termsNote === "" ? x.note : `${x.note}; ${termsNote}`, createdAt: madeAt.toISOString(), playbookVersion: playbook?.id ?? null };
    if (store.saveResearchBrief(req.id, brief, madeAt, shadow)) {
      out.done++;
      log(`[worker] research: request ${req.id} done, ${coins.length} coins, ${brief.sources.length} sources, ${freeNames.length} free names, ${shadow.length} shadow pick(s); ${x.note}`);
    }
  }
  return out;
}
