// Scrubs a saved X search page before it may be committed as a test fixture (Moment scanner ticket 01). A raw page holds the logged-in
// account's nav, its account switcher and profile link, every script and the page's own state. The scrub keeps only the <main> column
// (the posts), drops scripts, styles, links, forms and images' sources and removes all attributes except a short list the parser reads, then
// replaces any remaining mention of the account's handle. It is idempotent: a scrubbed page scrubs to itself, which is what the fixture test
// checks. Plain Node plus parse5.

import { createHash } from "node:crypto";
import { parse, serialize } from "parse5";

// Attributes the collector and the page checks read. Everything else (class, style, id, src, srcset, data-* of the app, nonces) is dropped.
const KEEP_ATTRS = new Set(["href", "role", "aria-label", "aria-labelledby", "aria-hidden", "aria-current", "aria-pressed", "aria-haspopup", "aria-expanded", "dir", "lang", "type", "alt", "tabindex", "data-engagement-action", "data-post-avatar", "data-slot"]);
const DROP_ELEMENTS = new Set(["script", "style", "link", "meta", "noscript", "iframe", "form", "input", "textarea", "select", "object", "embed", "template", "base", "canvas", "audio", "source", "track", "picture"]);
const HEAD = '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>X search fixture</title></head><body></body></html>';
const HANDLE_RE = /^[A-Za-z0-9_]{1,15}$/;

// A short fingerprint of a handle, lowercased: what the fixture test compares tokens against, so the test never holds the handle itself.
export const handleHash = (handle) => createHash("sha256").update(handle.toLowerCase()).digest("hex").slice(0, 12);

const attr = (node, name) => node.attrs?.find((a) => a.name === name)?.value;
const children = (node) => node.childNodes ?? [];

function find(node, test, out = []) {
  if (test(node)) out.push(node);
  for (const c of children(node)) find(c, test, out);
  return out;
}

const textOf = (node) => (node.nodeName === "#text" ? node.value : children(node).map(textOf).join(" "));

// The logged-in account's handle(s), read from the profile link of the primary nav and the account menu, before they are removed.
function accountHandles(doc) {
  const handles = new Set();
  for (const a of find(doc, (n) => n.tagName === "a" && attr(n, "aria-label") === "Profile")) {
    const href = attr(a, "href") ?? "";
    if (/^\/[A-Za-z0-9_]{1,15}$/.test(href)) handles.add(href.slice(1));
  }
  for (const b of find(doc, (n) => attr(n, "aria-label") === "Account menu")) {
    for (const m of textOf(b).matchAll(/@([A-Za-z0-9_]{1,15})/g)) handles.add(m[1]);
  }
  return [...handles];
}

function clean(node) {
  if (node.nodeName === "#comment") return false;
  if (node.tagName && DROP_ELEMENTS.has(node.tagName)) return false;
  if (node.tagName && (attr(node, "aria-label") === "Account menu" || (node.tagName === "nav" && attr(node, "aria-label") === "Primary"))) return false;
  if (node.attrs) node.attrs = node.attrs.filter((a) => KEEP_ATTRS.has(a.name));
  if (node.tagName === "svg") node.childNodes = []; // the icon's drawing is not read; its role and label stay
  if (node.childNodes) node.childNodes = node.childNodes.filter(clean);
  return true;
}

function replaceHandles(node, handles) {
  if (handles.length === 0) return 0;
  let n = 0;
  const swap = (text) => {
    let out = text;
    for (const h of handles) {
      // The handle is escaped to a literal by being split on, never built into a pattern.
      const lower = out.toLowerCase();
      const needle = h.toLowerCase();
      let at = lower.indexOf(needle);
      while (at >= 0) {
        out = `${out.slice(0, at)}argus_account${out.slice(at + needle.length)}`;
        n++;
        at = out.toLowerCase().indexOf(needle, at + "argus_account".length);
      }
    }
    return out;
  };
  const walk = (el) => {
    if (el.nodeName === "#text") el.value = swap(el.value);
    for (const a of el.attrs ?? []) a.value = swap(a.value);
    for (const c of children(el)) walk(c);
  };
  walk(node);
  return n;
}

/**
 * Scrubs one saved page. Returns { html, handleHashes, replaced }. Throws when the page has no <main> column: nothing is guessed.
 * `known` are handle hashes already on record; a handle found in the page is added.
 */
export function scrubPage(html) {
  const doc = parse(html);
  const handles = accountHandles(doc).filter((h) => HANDLE_RE.test(h));
  const mains = find(doc, (n) => n.tagName === "main");
  if (mains.length === 0) throw new Error("no <main> column in the page: not an X page this scrub knows");
  const out = parse(HEAD);
  const body = find(out, (n) => n.tagName === "body")[0];
  for (const m of mains) {
    clean(m);
    m.parentNode = body;
    body.childNodes.push(m);
  }
  const replaced = replaceHandles(body, handles);
  return { html: serialize(out), handleHashes: handles.map(handleHash), replaced };
}
