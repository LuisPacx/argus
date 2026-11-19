// The Moment scanner's loop, free of any real browser so it is tested with fakes (Moment scanner ticket 01). The child process script
// `packages/core/scripts/x-search-scan.mjs` wires it to the real lock, directory check and Chrome.
//
// The plan is a list of { id, url }. Every address is checked against the allowlist before anything loads. The loop is serial, jittered,
// reads only, and stops at the first STOP signal (no retry) and at a page where the selectors found nothing.

import { MOMENT_CONFIG } from "../moments/config.ts";
import { captureAll, classify, statusOf } from "./detect.mjs";
import { parsePosts, readStatus } from "./posts.mjs";
import { isAllowedXUrl } from "./urls.mjs";

// Exit codes of the child. 2 is a STOP signal (as in the spike); 3 is a held lock.
export const EXIT = { ok: 0, error: 1, stopped: 2, locked: 3, refused: 4, selectorsFoundNothing: 5 };

// Checks the plan's shape and addresses. Returns a problem string, or null when the plan may run.
export function planProblem(plan, maxLoads = MOMENT_CONFIG.loadsPerScan) {
  if (!Array.isArray(plan) || plan.length === 0) return "the plan must be a non-empty list of { id, url }";
  if (plan.length > maxLoads) return `the plan has ${plan.length} loads; at most ${maxLoads} are allowed`;
  for (const item of plan) {
    if (item === null || typeof item !== "object" || typeof item.id !== "string" || typeof item.url !== "string") return "every plan item must be { id, url } with text values";
    if (!isAllowedXUrl(item.url)) return `refused: "${String(item.url).slice(0, 80)}" is not a search page or a post page on x.com`;
  }
  return null;
}

/**
 * Runs the plan.
 *  - `lock`: () => { alive: boolean } | null, the directory's lock holder (a held lock exits 3 before any load)
 *  - `open`: async () => { load(url, { scrolls }) -> facts, close() }, the browser
 *  - `emit`: (object) => void, one call per page and one for the end
 *  - `sleep`, `jitter`: the pacing, replaced in tests
 * Returns { exit, loads, stopped }.
 */
export async function runScan({ plan, lock, open, emit, sleep, jitter, maxLoads = MOMENT_CONFIG.loadsPerScan, scrolls = MOMENT_CONFIG.scrollsPerPage }) {
  const problem = planProblem(plan, maxLoads);
  if (problem) {
    emit({ done: true, exit: EXIT.refused, loads: 0, reason: problem });
    return { exit: EXIT.refused, loads: 0, stopped: null };
  }
  const holder = lock();
  if (holder?.alive) {
    emit({ done: true, exit: EXIT.locked, loads: 0, reason: `a Chrome process (pid ${holder.pid}) already holds the directory` });
    return { exit: EXIT.locked, loads: 0, stopped: null };
  }
  const session = await open();
  let halted = false;
  let nothing = false;
  // captureAll takes the targets as an iterable: this one ends early after a page where the selectors found nothing.
  function* targets() {
    for (const item of plan) {
      if (halted) return;
      yield item;
    }
  }
  let results = [];
  let loads = 0;
  let stopped = null;
  try {
    ({ results, loads, stopped } = await captureAll(
      targets(),
      async (item) => {
        const started = Date.now();
        let facts;
        try {
          facts = await session.load(item.url, { scrolls });
        } catch (e) {
          // A load that threw (timeout, crash) is an error record, not an account signal: it is not retried and the loop goes on.
          const rec = { id: item.id, url: item.url, status: "error", signals: [], error: String(e && e.message).split("\n")[0].slice(0, 200), posts: [], ms: Date.now() - started };
          emit(rec);
          return rec;
        }
        const signals = classify({ url: facts.url, text: facts.text, loggedIn: facts.loggedIn, hasLoginButton: facts.hasLoginButton, hasChallengeWidget: facts.hasChallengeWidget });
        const stopStatus = statusOf(signals);
        const parsed = stopStatus === "ok" ? parsePosts(facts.articles) : { posts: [], skipped: { promoted: 0, noStatusLink: 0 } };
        const status = readStatus({ stopStatus, articleCount: facts.articleCount, parsed, emptyState: facts.emptyState });
        if (status === "selectors_found_nothing") {
          halted = true;
          nothing = true;
        }
        const rec = { id: item.id, url: item.url, status, signals, httpStatus: facts.httpStatus ?? null, articleCount: facts.articleCount, posts: parsed.posts, skipped: parsed.skipped, ms: Date.now() - started };
        emit(rec);
        return rec;
      },
      { maxLoads, pause: () => sleep(jitter(MOMENT_CONFIG.gapMs.min, MOMENT_CONFIG.gapMs.max)) },
    ));
  } finally {
    await session.close();
  }
  const exit = stopped ? EXIT.stopped : nothing ? EXIT.selectorsFoundNothing : results.some((r) => r.status === "error") ? EXIT.error : EXIT.ok;
  emit({ done: true, exit, loads, stopped });
  return { exit, loads, stopped };
}
