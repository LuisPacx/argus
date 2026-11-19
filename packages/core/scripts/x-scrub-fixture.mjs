#!/usr/bin/env node
// Scrubs a raw X search page into a committable fixture (Moment scanner ticket 01).
//
//   node x-scrub-fixture.mjs <raw.html> <fixtures dir> <name>      writes <fixtures dir>/<name>.html and records the handle hashes
//   node x-scrub-fixture.mjs --check <fixtures dir>                exits 1 when scrubbing any fixture there would change it
//
// The raw page (the account's nav, account switcher, scripts, state) is read from where the capture saved it (0600, under a 700 directory
// outside the repository) and is never committed. The fixtures dir holds <name>.html files and `scrubbed-handles.json`: sha256 prefixes of the
// handles that were removed, so the fixture test can prove none is left without the test knowing a handle.

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { scrubPage } from "../src/x-capture/scrub.mjs";

export const HASH_FILE = "scrubbed-handles.json";

export function readHashes(dir) {
  const file = join(dir, HASH_FILE);
  return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : [];
}

// Files in `dir` whose scrub would change them. Empty means the fixtures are clean.
export function changedByScrub(dir) {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".html"))
    .filter((f) => scrubPage(readFileSync(join(dir, f), "utf8")).html !== readFileSync(join(dir, f), "utf8"));
}

export function scrubFile(rawPath, dir, name) {
  const { html, handleHashes, replaced } = scrubPage(readFileSync(rawPath, "utf8"));
  writeFileSync(join(dir, `${name}.html`), html, { mode: 0o644 });
  const all = [...new Set([...readHashes(dir), ...handleHashes])].sort();
  writeFileSync(join(dir, HASH_FILE), `${JSON.stringify(all, null, 2)}\n`);
  return { bytes: html.length, handleHashes, replaced };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [a, b, c] = process.argv.slice(2);
  if (a === "--check" && b) {
    const changed = changedByScrub(b);
    console.log(changed.length === 0 ? "clean: nothing left to scrub" : `would change: ${changed.join(", ")}`);
    process.exit(changed.length === 0 ? 0 : 1);
  } else if (a && b && c) {
    const r = scrubFile(a, b, c);
    console.log(`wrote ${join(b, `${c}.html`)} (${r.bytes} characters), ${r.handleHashes.length} handle(s) recorded by hash, ${r.replaced} mention(s) replaced`);
  } else {
    console.error("usage: x-scrub-fixture.mjs <raw.html> <fixtures dir> <name> | --check <fixtures dir>");
    process.exit(2);
  }
}
