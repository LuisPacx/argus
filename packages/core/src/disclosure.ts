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

const VOID_TAGS = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"]);
/** Elements whose content is not page text: skipped through their closing tag, markup and all. */
const SKIPPED = new Set(["script", "style", "noscript", "template", "title", "textarea"]);
const HIDING_DECL_RE = /(?:^|[;{\s])(?:display\s*:\s*none|visibility\s*:\s*hidden)\b/i;
const TOKEN_RE = /<!--[\s\S]*?-->|<(\/?)([a-zA-Z][^\s/>]*)((?:"[^"]*"|'[^']*'|[^'">])*)>|<![^>]*>|<\?[^>]*>|[^<]+|</g;

function attributes(raw: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of raw.matchAll(/([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g)) {
    const key = m[1]!.toLowerCase();
    if (!out.has(key)) out.set(key, m[2] ?? m[3] ?? m[4] ?? "");
  }
  return out;
}

/** Simple `.class`, `#id` and `tag` selectors in the page's own <style> blocks that hide what they match. */
function hidingSelectors(html: string): { classes: Set<string>; ids: Set<string>; tags: Set<string> } {
  const out = { classes: new Set<string>(), ids: new Set<string>(), tags: new Set<string>() };
  for (const block of html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi)) {
    for (const rule of block[1]!.replace(/\/\*[\s\S]*?\*\//g, " ").matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      if (!HIDING_DECL_RE.test(rule[2]!)) continue;
      for (const sel of rule[1]!.split(",").map((x) => x.trim())) {
        const m = /^([.#]?)([a-zA-Z_][\w-]*)$/.exec(sel);
        if (m) (m[1] === "." ? out.classes : m[1] === "#" ? out.ids : out.tags).add(m[2]!.toLowerCase());
      }
    }
  }
  return out;
}

/**
 * The text a visitor could read, from a small tokenizer rather than regexes over the whole page: comments, scripts, styles,
 * <noscript>, <template>, <title> and the head are dropped, and so is everything inside an element that is hidden (the
 * `hidden` or `aria-hidden="true"` attribute, an inline `display:none` or `visibility:hidden`, or a simple class, id or tag
 * selector in the page's own <style> that sets one). Not covered, and a limit of this check: external stylesheets, compound
 * selectors, off-screen positioning and tiny or transparent text; only a real browser render would close those.
 */
export function visibleText(html: string): string {
  const hiding = hidingSelectors(html);
  const stack: { name: string; hidden: boolean }[] = [];
  const parts: string[] = [];
  let skipUntil: string | undefined;
  for (const m of html.matchAll(TOKEN_RE)) {
    const [token, closing, rawName, rawAttrs = ""] = m;
    if (skipUntil) {
      if (closing && rawName!.toLowerCase() === skipUntil) skipUntil = undefined;
      continue;
    }
    if (!rawName) {
      if (!token.startsWith("<") && !stack.some((e) => e.hidden)) parts.push(token);
      continue;
    }
    const name = rawName.toLowerCase();
    if (closing) {
      const i = stack.findLastIndex((e) => e.name === name);
      if (i >= 0) stack.length = i;
      continue;
    }
    const selfClosed = /\/\s*$/.test(rawAttrs);
    if (SKIPPED.has(name)) {
      if (!selfClosed) skipUntil = name;
      continue;
    }
    if (VOID_TAGS.has(name) || selfClosed) continue;
    const attrs = attributes(rawAttrs);
    const hidden =
      name === "head" ||
      attrs.has("hidden") ||
      attrs.get("aria-hidden")?.trim().toLowerCase() === "true" ||
      HIDING_DECL_RE.test(attrs.get("style") ?? "") ||
      hiding.tags.has(name) ||
      (attrs.get("class") ?? "").toLowerCase().split(/\s+/).some((c) => hiding.classes.has(c)) ||
      hiding.ids.has((attrs.get("id") ?? "").toLowerCase());
    stack.push({ name, hidden });
  }
  // Tags separate words ("a</b>b" is two); the squash below keeps a sentence split across visible tags intact.
  return parts.join(" ").replace(/\s+/g, " ");
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
