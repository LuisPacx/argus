/**
 * The creator disclosure every Build page must show (architecture invariant 4, ADR 0003). argus holds the canonical text
 * here, hardcoded, and never takes it from a Build repo: the Build is the thing being verified.
 */
export const DISCLOSURE_SENTENCE = "This project was created by argus, an autonomous project builder. The creator may sell this project.";

const NOT_FOUND_PATH = "/__argus_not_found__";

export interface DisclosureOptions {
  /** Tries for `/` to respond (a fresh workers.dev deploy can take a moment). Default 6. */
  attempts?: number;
  /** Wait between those tries. Default 5000 ms. */
  delayMs?: number;
  /** Most paths crawled; reaching it fails the check as incomplete. Default 200. */
  maxPages?: number;
  /** Per-request timeout. Default 15000 ms. */
  timeoutMs?: number;
}

export interface DisclosureResult {
  ok: boolean;
  problems: string[];
  /** HTML pages checked. */
  pages: number;
}

const looksLikeHtml = (contentType: string, body: string): boolean =>
  /html/i.test(contentType) || /^\s*(<!doctype\s+html|<html[\s>]|<head[\s>]|<body[\s>])/i.test(body);

/** The text a visitor could read: comments, scripts and styles are dropped, tags removed, whitespace collapsed. */
function visibleText(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ");
}

// "words , more" would break a sentence split across tags at a comma, so tags are replaced by a space and the comparison
// ignores spacing around punctuation.
const squash = (s: string) => s.replace(/\s+([.,;:!?])/g, "$1").replace(/\s+/g, " ").trim();
const REQUIRED = squash(DISCLOSURE_SENTENCE);

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Crawls a deployed preview and checks the disclosure itself, never trusting the Build's own check. Starts at `/`, follows
 * same-origin `<a href>` links and same-origin redirects, and also requests a path that does not exist, because a 404 page is
 * a page too. Every response that is HTML (by content type or by looking like HTML) must show the exact sentence as visible
 * text. Hitting the page cap fails the check as incomplete. `/` must respond with a non-error status within `attempts` tries.
 */
export async function checkDisclosure(baseUrl: string, fetchFn: typeof fetch, opts: DisclosureOptions = {}): Promise<DisclosureResult> {
  const { attempts = 6, delayMs = 5_000, maxPages = 200, timeoutMs = 15_000 } = opts;
  const origin = new URL(baseUrl).origin;
  const problems: string[] = [];
  const get = (path: string) =>
    fetchFn(new URL(path, origin), { redirect: "manual", signal: AbortSignal.timeout(timeoutMs), headers: { "user-agent": "argus-build-runner" } });

  let root: Response | undefined;
  let rootError = "";
  for (let i = 0; i < attempts && !root; i++) {
    if (i > 0) await sleep(delayMs);
    try {
      const res = await get("/");
      if (res.status >= 200 && res.status < 400) root = res;
      else rootError = `HTTP ${res.status}`;
    } catch (e) {
      rootError = e instanceof Error ? e.message : String(e);
    }
  }
  if (!root) return { ok: false, problems: [`/: the preview did not respond after ${attempts} tries (${rootError})`], pages: 0 };

  const seen = new Set<string>();
  const queue: string[] = ["/", NOT_FOUND_PATH];
  let pages = 0;
  while (queue.length > 0) {
    const path = queue.shift()!;
    if (seen.has(path)) continue;
    if (seen.size >= maxPages) {
      queue.unshift(path);
      break;
    }
    seen.add(path);
    let res: Response;
    try {
      res = path === "/" && root ? root : await get(path);
    } catch (e) {
      problems.push(`${path}: request failed (${e instanceof Error ? e.message : String(e)})`);
      continue;
    }
    const location = res.status >= 300 && res.status < 400 ? res.headers.get("location") : null;
    if (location) {
      try {
        const next = new URL(location, new URL(path, origin));
        if (next.origin === origin) queue.push(next.pathname + next.search);
      } catch {
        // an unparseable Location is not a page
      }
    }
    let body: string;
    try {
      body = await res.text();
    } catch (e) {
      problems.push(`${path}: could not read the response (${e instanceof Error ? e.message : String(e)})`);
      continue;
    }
    if (!looksLikeHtml(res.headers.get("content-type") ?? "", body)) continue;
    pages++;
    if (!squash(visibleText(body)).includes(REQUIRED)) problems.push(`${path}: HTML page without the exact disclosure sentence`);
    for (const m of body.matchAll(/<a\b[^>]*?\shref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi)) {
      const href = m[1] ?? m[2] ?? m[3] ?? "";
      try {
        const target = new URL(href, new URL(path, origin));
        if (target.origin === origin) queue.push(target.pathname + target.search);
      } catch {
        // not a usable link
      }
    }
  }
  const left = new Set(queue.filter((p) => !seen.has(p)));
  if (left.size > 0) problems.push(`page cap reached (${maxPages}): ${left.size} path(s) left uncrawled, so the disclosure check is incomplete`);
  if (pages === 0) problems.push("no HTML page was reachable from /");
  return { ok: problems.length === 0, problems, pages };
}
