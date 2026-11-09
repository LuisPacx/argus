import { parse, type DefaultTreeAdapterMap } from "parse5";
import { visibleText } from "../disclosure.ts";
import { guardedGet, type Resolver, type Transport } from "./guarded-fetch.ts";

/**
 * The website part of a Snapshot: one plain fetch of one URL a token's creator named. SSRF-guarded on every hop, robots.txt honoured
 * for every host it touches, size- and time-capped, HTML only. Everything it returns is untrusted text from the open web.
 */

type Node = DefaultTreeAdapterMap["node"];
type Element = DefaultTreeAdapterMap["element"];

export type WebsiteStatus = "ok" | "blocked" | "robots-disallowed" | "non-html" | "http-error" | "timeout" | "redirect-limit" | "error";

export interface WebsiteFetch {
  status: WebsiteStatus;
  /** Why, for statuses other than ok; short, never a URL query. */
  detail: string;
  httpStatus: number | null;
  finalUrl: string | null;
  contentType: string | null;
  title: string;
  /** Visible text, markup and control characters removed, capped. */
  text: string;
  /** The page was longer than the byte cap and was cut. */
  truncated: boolean;
  responseMs: number | null;
  /** The page is an empty app shell (a script-rendered page with almost no text of its own); null when there is no HTML page. */
  emptyShell: boolean | null;
}

export interface WebsiteFetchOptions {
  maxBytes: number;
  textChars: number;
  timeoutMs: number;
  emptyShellMaxVisibleChars: number;
  resolve?: Resolver;
  transport?: Transport;
}

const ROBOTS_MAX_BYTES = 64 * 1024;
const BLOCKED_PREFIX = "blocked: ";
/** Limits on what is read from an untrusted robots.txt: groups, rules per group, characters per rule, and the path matched against. */
const MAX_GROUPS = 200;
const MAX_RULES_PER_GROUP = 500;
const MAX_RULE_CHARS = 512;
const MAX_PATH_CHARS = 2_048;
/** Our robots.txt product tokens, lower case: a group naming either applies to us. */
const OUR_AGENTS = ["argusstudy", "argus"];
const MOUNT_IDS = new Set(["root", "app", "__next", "__nuxt", "___gatsby", "svelte", "q-app", "react-root", "main-app"]);
// Controls and invisible direction/format characters; ordinary whitespace is collapsed separately.
// eslint-disable-next-line no-control-regex
const CONTROLS = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F​-‏‪-‮⁠-⁩﻿]/g;

const clean = (s: string, max: number) => s.replace(CONTROLS, "").replace(/\s+/g, " ").trim().slice(0, max);

const attr = (el: Element, name: string): string | undefined => el.attrs.find((a) => a.name === name)?.value;
const isElement = (n: Node): n is Element => "tagName" in n;
const childNodes = (n: Node): Node[] => ("childNodes" in n ? n.childNodes : []);
const contentNodes = (el: Element): Node[] => (el.tagName === "template" && "content" in el ? childNodes((el as unknown as { content: Node }).content) : childNodes(el));

function walk(nodes: Node[], visit: (el: Element) => void): void {
  for (const n of nodes) {
    if (!isElement(n)) continue;
    visit(n);
    walk(contentNodes(n), visit);
  }
}

export interface HtmlAnalysis {
  title: string;
  text: string;
  emptyShell: boolean;
}

/** Title, visible text and the empty-app-shell flag of one HTML page. */
export function analyzeHtml(html: string, textChars: number, emptyShellMaxVisibleChars: number): HtmlAnalysis {
  const doc = parse(html);
  let title = "";
  let scripts = 0;
  let noscripts = 0;
  let mount = false;
  walk(childNodes(doc), (el) => {
    if (el.tagName === "title" && !title) title = clean(childNodes(el).map((c) => ("value" in c ? String(c.value) : "")).join(""), 300);
    else if (el.tagName === "script") scripts++;
    else if (el.tagName === "noscript") noscripts++;
    if (MOUNT_IDS.has((attr(el, "id") ?? "").toLowerCase())) mount = true;
  });
  const full = clean(visibleText(html), Number.MAX_SAFE_INTEGER);
  const emptyShell = full.length < emptyShellMaxVisibleChars && scripts > 0 && (mount || noscripts > 0);
  return { title, text: full.slice(0, textChars), emptyShell };
}

interface RobotsGroup {
  agents: string[];
  rules: Array<{ allow: boolean; pattern: string }>;
}

function parseRobots(body: string): RobotsGroup[] {
  const groups: RobotsGroup[] = [];
  let current: RobotsGroup | undefined;
  let lastWasAgent = false;
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    const m = /^([A-Za-z-]+)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1]!.toLowerCase();
    const value = m[2]!.trim();
    if (key === "user-agent") {
      if (!current || !lastWasAgent) {
        if (groups.length >= MAX_GROUPS) break;
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
    } else if ((key === "allow" || key === "disallow") && current) {
      lastWasAgent = false;
      // A rule that is empty, over-long, or past the group's cap is dropped (never an error): the file is untrusted.
      if (value !== "" && value.length <= MAX_RULE_CHARS && current.rules.length < MAX_RULES_PER_GROUP) current.rules.push({ allow: key === "allow", pattern: value });
    } else lastWasAgent = false;
  }
  return groups;
}

/**
 * A robots pattern (`*` any run, a final `$` end anchor) against path+query, as a prefix match (Google's semantics).
 * Linear: the pattern is split at `*` and each piece is found left to right, greedily and without backtracking, so a hostile
 * robots.txt cannot make it exponential (the match is synchronous and would freeze the worker). No RegExp is built from the pattern.
 */
export function patternMatches(pattern: string, path: string): boolean {
  const anchored = pattern.endsWith("$");
  const parts = (anchored ? pattern.slice(0, -1) : pattern).split("*");
  const first = parts[0]!;
  if (!path.startsWith(first)) return false;
  if (parts.length === 1) return !anchored || path.length === first.length;
  let pos = first.length;
  for (let i = 1; i < parts.length - 1; i++) {
    const piece = parts[i]!;
    if (piece === "") continue;
    const at = path.indexOf(piece, pos);
    if (at < 0) return false;
    pos = at + piece.length;
  }
  const last = parts[parts.length - 1]!;
  if (anchored) return path.length - last.length >= pos && path.endsWith(last);
  return last === "" || path.indexOf(last, pos) >= 0;
}

/** RFC 9309: our own group if there is one, else `*`; the longest matching rule wins and Allow wins a tie. */
export function robotsAllows(body: string, rawPathAndQuery: string): boolean {
  const pathAndQuery = rawPathAndQuery.slice(0, MAX_PATH_CHARS);
  const groups = parseRobots(body);
  const ours = groups.filter((g) => g.agents.some((a) => OUR_AGENTS.includes(a)));
  const chosen = ours.length > 0 ? ours : groups.filter((g) => g.agents.includes("*"));
  let best: { allow: boolean; length: number } | undefined;
  for (const g of chosen) {
    for (const r of g.rules) {
      if (!patternMatches(r.pattern, pathAndQuery)) continue;
      const length = r.pattern.length;
      if (!best || length > best.length || (length === best.length && r.allow && !best.allow)) best = { allow: r.allow, length };
    }
  }
  return best ? best.allow : true;
}

const failure = (status: WebsiteStatus, detail: string): WebsiteFetch => ({ status, detail, httpStatus: null, finalUrl: null, contentType: null, title: "", text: "", truncated: false, responseMs: null, emptyShell: null });

/** Fetches one page. Never throws. */
export async function fetchWebsite(rawUrl: string, opts: WebsiteFetchOptions): Promise<WebsiteFetch> {
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), opts.timeoutMs);
  const net = { resolve: opts.resolve, transport: opts.transport, signal: deadline.signal };
  const robotsByOrigin = new Map<string, string | null>(); // body, or null for "not allowed to read anything"
  // robots.txt for the origin of every URL the fetch is about to request, the first one and each redirect target.
  const beforeRequest = async (url: URL): Promise<string | undefined> => {
    if (!robotsByOrigin.has(url.origin)) {
      const r = await guardedGet(`${url.origin}/robots.txt`, { ...net, maxBytes: ROBOTS_MAX_BYTES, timeoutMs: opts.timeoutMs });
      if (r.ok && r.status >= 200 && r.status < 300) robotsByOrigin.set(url.origin, r.body.toString("utf8"));
      else if (r.ok && r.status >= 400 && r.status < 500) robotsByOrigin.set(url.origin, ""); // no robots.txt: everything is allowed
      else if (!r.ok && r.reason === "blocked") return `${BLOCKED_PREFIX}${r.detail}`; // the host itself is not public: not a robots matter
      else if (!r.ok && deadline.signal.aborted) throw new Error("deadline");
      else robotsByOrigin.set(url.origin, null); // 5xx or unreachable: assume nothing is allowed
    }
    const body = robotsByOrigin.get(url.origin);
    if (body === null) return `robots.txt of ${url.host} could not be read`;
    return robotsAllows(body ?? "", `${url.pathname}${url.search}`) ? undefined : `robots.txt of ${url.host} disallows this page`;
  };
  try {
    const r = await guardedGet(rawUrl, { ...net, maxBytes: opts.maxBytes, timeoutMs: opts.timeoutMs, beforeRequest, headers: { accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.1" } });
    if (!r.ok) {
      const blockedByRobotsFetch = r.reason === "refused" && r.detail.startsWith(BLOCKED_PREFIX);
      const status: WebsiteStatus = blockedByRobotsFetch ? "blocked" : r.reason === "refused" ? "robots-disallowed" : r.reason;
      return failure(status, r.detail.replace(BLOCKED_PREFIX, "").replace(/[?#]\S*/g, "").slice(0, 200));
    }
    const contentType = r.headers["content-type"] ?? null;
    const base = { httpStatus: r.status, finalUrl: r.finalUrl, contentType, truncated: r.truncated, responseMs: r.elapsedMs };
    if (r.status < 200 || r.status >= 300) return { ...failure("http-error", `HTTP ${r.status}`), ...base };
    if (!/^(text\/html|application\/xhtml\+xml)\b/i.test(contentType ?? "")) return { ...failure("non-html", `content type ${(contentType ?? "none").slice(0, 80)}`), ...base };
    const a = analyzeHtml(r.body.toString("utf8"), opts.textChars, opts.emptyShellMaxVisibleChars);
    return { status: "ok", detail: "", ...base, title: a.title, text: a.text, emptyShell: a.emptyShell };
  } catch (e) {
    return deadline.signal.aborted ? failure("timeout", `no complete answer within ${opts.timeoutMs} ms`) : failure("error", e instanceof Error ? e.message.slice(0, 200) : "unknown error");
  } finally {
    clearTimeout(timer);
  }
}
