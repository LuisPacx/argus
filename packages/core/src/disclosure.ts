import { parse, type DefaultTreeAdapterMap } from "parse5";

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

/** Elements whose content is not page text: comments never reach the tree, and these are skipped, markup and all. */
const NOT_TEXT = new Set([
  "script",
  "style",
  "noscript",
  "template",
  "title",
  "textarea",
  "head",
  // Fallback content of an element the browser does render: never shown.
  "iframe",
  "noembed",
  "noframes",
]);
const HIDING_DECL_RE = /(?:^|[;{\s])(?:display\s*:\s*none|visibility\s*:\s*hidden)\b/i;

type Node = DefaultTreeAdapterMap["node"];
type Element = DefaultTreeAdapterMap["element"];

const isElement = (n: Node): n is Element => "tagName" in n;
const attr = (el: Element, name: string): string | undefined => el.attrs.find((a) => a.name === name)?.value;
const children = (n: Node): Node[] => ("childNodes" in n ? n.childNodes : []);

/** Every element in the tree, in document order (the contents of a <template> are not part of the page). */
function* elements(node: Node): Generator<Element> {
  for (const child of children(node)) {
    if (!isElement(child)) continue;
    yield child;
    yield* elements(child);
  }
}

/**
 * Simple `.class`, `#id` and `tag` selectors in the page's own <style> blocks that hide what they match. The CSS is the text
 * of the parsed <style> elements, not a search through the raw HTML.
 */
function hidingSelectors(root: Node): { classes: Set<string>; ids: Set<string>; tags: Set<string> } {
  const out = { classes: new Set<string>(), ids: new Set<string>(), tags: new Set<string>() };
  for (const el of elements(root)) {
    if (el.tagName !== "style") continue;
    const css = children(el)
      .map((c) => ("value" in c ? c.value : ""))
      .join("");
    for (const rule of css.replace(/\/\*[\s\S]*?\*\//g, " ").matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
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
 * The text a visitor could read, from a real HTML parser (parse5, the HTML spec's own algorithm), so the tree is the one a
 * browser builds and entities in attribute values are decoded before any check. Comments, scripts, styles, <noscript>,
 * <template>, <title>, <textarea>, the head and the fallback content of <iframe> are dropped, and so is everything inside an
 * element that is hidden: the `hidden` or `aria-hidden="true"` attribute, an inline `display:none` or `visibility:hidden`, a
 * simple class, id or tag selector in the page's own <style> that sets one, the content of a closed <details> other than its
 * <summary>, and a <dialog> without `open`. Not covered, and a limit of this check: external stylesheets, compound selectors,
 * off-screen positioning and tiny or transparent text; only a real browser render would close those.
 */
export function visibleText(html: string): string {
  const doc = parse(html);
  const hiding = hidingSelectors(doc);
  const parts: string[] = [];
  const walk = (nodes: Node[], hidden: boolean): void => {
    for (const child of nodes) {
      if (!isElement(child)) {
        if (child.nodeName === "#text" && !hidden) parts.push((child as DefaultTreeAdapterMap["textNode"]).value);
        continue;
      }
      const name = child.tagName;
      if (NOT_TEXT.has(name)) continue;
      const hides =
        attr(child, "hidden") !== undefined ||
        attr(child, "aria-hidden")?.trim().toLowerCase() === "true" ||
        HIDING_DECL_RE.test(attr(child, "style") ?? "") ||
        (name === "dialog" && attr(child, "open") === undefined) ||
        hiding.tags.has(name) ||
        (attr(child, "class") ?? "").toLowerCase().split(/\s+/).some((c) => hiding.classes.has(c)) ||
        hiding.ids.has((attr(child, "id") ?? "").toLowerCase());
      if (name === "details" && attr(child, "open") === undefined) {
        // Closed: only the <summary> shows.
        walk(children(child).filter((inner) => isElement(inner) && inner.tagName === "summary"), hidden || hides);
        continue;
      }
      walk(children(child), hidden || hides);
    }
  };
  walk(children(doc), false);
  // Tags separate words ("a</b>b" is two); the squash below keeps a sentence split across visible tags intact.
  return parts.join(" ").replace(/\s+/g, " ");
}

/** The `href` of every `<a>` in the page, decoded as a browser would read it. */
function linkTargets(html: string): string[] {
  const out: string[] = [];
  for (const el of elements(parse(html))) {
    const href = el.tagName === "a" ? attr(el, "href") : undefined;
    if (href !== undefined) out.push(href);
  }
  return out;
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
    for (const href of linkTargets(body)) {
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
