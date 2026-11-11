import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * ADR 0002 enforcement: argus never touches a chain. It holds no wallet, signs nothing, sends nothing.
 *
 * The rule is about what the code can DO, not what it mentions, so it does not flag the read-only Sources:
 * PumpPortal's public data stream (`wss://pumpportal.fun/api/data`, new-launch events) and DexScreener's public REST API read
 * public market data and are not chain calls. A source file (.ts, .mjs, .js, .vue) or a package.json is a violation if it has any of:
 *   1. a dependency or import of a chain, wallet or key SDK (`@solana/*`, `@pump-fun/*`, `@coral-xyz/*`, `@metaplex*`, `ethers`, ...);
 *   2. a URL to an RPC or transaction endpoint: a Solana RPC or RPC provider host, or a trading, swap or tx-relay endpoint;
 *      on pumpportal.fun only `/api/data` is allowed (not `/api/trade*`), and on pump.fun only `/coin/` links;
 *   3. a JSON-RPC method name that reads or writes the chain, as a string literal (`"sendTransaction"`, `"getBalance"`, ...);
 *   4. key handling: `Keypair`, `secretKey`, `privateKey`, `PRIVATE_KEY`, `mnemonic`.
 * Tests are scanned too, except this file, which has to spell the banned names.
 *
 * The one exception is the ADR 0002 Amendment (Phase 3, 2026-11-07): read-only chain reads. It is granted to exactly one file,
 * READ_ONLY_RPC_MODULE, and only for READ_ONLY_RPC_HOST (https, path "/") and READ_ONLY_RPC_METHODS. Everything else in rules 1-4 still
 * applies in that file (no SDK, no key, no write or signing method, no other host), and nothing is allowed anywhere else.
 *
 * This is a tripwire, not a proof. A banned host is caught as a URL (literal scheme) and, since ticket 23, as a bare hostname in the text
 * whatever precedes it (`${scheme}://h`, `"//h"`, `"ht" + "tps://h"`, a constant), after undoing escapes (a `\n`, `\r` or `\t` escape too: a
 * URL parser drops LF, CR and TAB), percent-encoding, case, full-width and zero-width forms, and after joining adjacent string literals.
 * Each of these views of the text is scanned on its own and can only add findings.
 * Still uncovered (each of these passes today):
 *   - a host or URL read from a file, the network, config or a lookup table; base64 or any other encoding the code decodes at run time
 *     (`atob`, `Buffer.from`, `.reverse()`, `.replace()`); a host assembled from a variable (`"api." + vendor + ".xyz"`); an IP address or a
 *     CNAME of a banned host;
 *   - a local validator on a non-default port or a non-canonical loopback spelling (`[::ffff:127.0.0.1]`, `0.0.0.0`); a loopback port
 *     variable that holds `8899` at run time; chaining after the closing quote of a loopback template (`` `http://127.0.0.1:${p}` + "@" + h ``);
 *   - a line break or tab spelled any way but a `\n`, `\r` or `\t` escape: raw inside a template literal or string (`` `https://api.hel<LF>ius.xyz/` ``),
 *     `\x0a`, `\u000a`, `\u{a}`, `&#10;`, `&Tab;`, `&NewLine;`; octal escapes (`\011`, `\150`); a line comment between joined literals;
 *     an escaped quote right after a host ends it (harmless: a quote is no host character);
 *   - a signing primitive reached through an alias or a bracket (`const c = require("node:crypto"); c.sign(...)`, `crypto["sign"](...)`),
 *     a destructuring with a nested brace before it (`const { a = {}, sign } = require("node:crypto")`), or a split `"ed" + "25519"`;
 *   - a loopback port interpolation whose `}` comes from a regex literal or a line comment inside it, outside the module (the interpolation
 *     may hold no brace, quote or backtick, but these still pass): `${p.replace(/}/g,x)}@${h}/`, `${ /}/.source }@${h}/`, and `${p // }/`
 *     + newline + `}@${h}/` (same on main, not a regression); a port variable whose run-time value contains `@host` (not only 8899);
 *   - import and signing spellings (same on main): `import c, { sign } from "node:crypto"`; `export { sign } from "node:crypto"`;
 *     `const { sign } = await import("node:crypto")`; a line comment inside the import braces before `sign`; a comment between `import` and
 *     `(` in a dynamic import of a banned package;
 *   - any file that is not scanned (JSON, Markdown, config, anything under `fixtures/`).
 * Cost: on 20k characters of adversarial input every scan measures under about 100 ms. Five small quadratic scans are known (all under
 * roughly 100 ms at 40k characters): the module's computed-key rule (`["` repeated), `import {sign ` repeated, `const { a, ` repeated,
 * `"//", [` repeated, and the pinned host followed by `.,` repeated. The test "no scan goes cubic or worse" feeds `violations()`
 * 20k-character runs of every character the scans quantify over (after a small probe, because a cubic scan would not finish). It catches
 * cubic or worse; it does not catch a quadratic scan, which stays small at these sizes. Keep it green when a normaliser or
 * a scanner changes, and never put two quantified runs of one character class next to each other (`\s*\)?\s*` was cubic: a quote and 4000
 * spaces took 36 s).
 *
 * Rule for whoever writes or tests packages/core/src/study/helius.ts: the bare-host scan reads comments, docs and fixtures too, and there
 * is no exemption for prose or test files. The test "guidance for helius.ts and its test" below proves the recipe with a sample module and
 * a sample test; keep it in step with this text.
 *  (1) The pinned host may be spelled out only inside helius.ts, as a plain token or in a literal `https://mainnet.helius-rpc.com/` URL
 *      (path "/" or a query). One sentence-ending period after it in a comment is accepted: a single period followed by whitespace or the
 *      end of the text and not directly after `/`, `@` or a quote (so `// Calls mainnet.helius-rpc.com. Read-only.` and
 *      `" mainnet.helius-rpc.com. "` pass; `"mainnet.helius-rpc.com."` and `https://mainnet.helius-rpc.com./` do not).
 *  (2) Tests of that module must not spell the host. Export the whole endpoint from helius.ts under a name that is NOT an RPC endpoint
 *      setting. RPC_ENDPOINT_SETTING is case-insensitive and matches any prefix or suffix: every name with `rpc`, an optional `_` and `url`,
 *      `uri`, `endpoint` or `host` in it (`HELIUS_RPC_URL`, `RPC_URL`, `RPC_ENDPOINT`, `rpcUrl`, `rpcEndpoint`, `heliusRpcHost`, `MY_RPC_URI_2`)
 *      and every name starting `HELIUS_` except `HELIUS_API_KEY` is flagged, both where it is declared and in a test that imports it;
 *      `PINNED_ENDPOINT` (no `rpc` in it) is fine. The scan does not ban `import ... from
 *      "./helius.ts"` (it bans only chain, wallet and key packages). Do not rebuild a URL from a host constant in a test (`https://${HOST}/`,
 *      `"https://" + HOST`): that is "a host built at run time" and would need a DYNAMIC_HOST_FILES entry, which is the Operator's call.
 *  (3) Only helius.ts itself may contain `jsonrpc` or one of the quoted RPC method names, so a test asserts the method by importing a verb
 *      constant exported from the module (`TX_VERB = "getTransaction"`), never by spelling it, and builds no JSON-RPC envelope by hand.
 *      Inside the module, `method:` must be followed by the literal: `method: TX_VERB` is flagged as a method that is not a literal, so the
 *      module writes `method: "getTransaction"` in the request next to the exported `TX_VERB = "getTransaction"` (the module's own test can
 *      assert that the two agree, by reading the sent body's method and comparing it to TX_VERB).
 *  (4) Comments and fixtures must not name any other banned host (an RPC provider, a swap or relay host); write "an RPC provider".
 *  (5) Prose naming `pump.fun` is allowed only in the frozen BARE_APEX_FILES.
 * Response fixtures can sit in a .json file under a fixtures/ directory, which this walk does not read.
 */

const BANNED_PACKAGES = [
  /^@solana(-program|-mobile)?\//,
  /^@pump-fun\//,
  /^@coral-xyz\//,
  /^@metaplex(-foundation)?\//,
  /^@project-serum\//,
  /^@jup-ag\//,
  /^@helius/,
  /^helius-sdk$/,
  /^@noble\/(ed25519|secp256k1)$/,
  /^tweetnacl$/,
  /^ethers$/,
  /^viem$/,
  /^web3$/,
  /^bip39$/,
  /^ed25519-hd-key$/,
];

const BANNED_HOSTS = [
  /(^|\.)solana\.com$/,
  /(^|\.)solana\.org$/,
  /(^|\.)helius(-rpc)?\.(com|xyz|dev)$/,
  /(^|\.)quiknode\.pro$/,
  /(^|\.)quicknode\.(com|pro)$/,
  /(^|\.)alchemy\.com$/,
  /(^|\.)ankr\.com$/,
  /(^|\.)rpcpool\.com$/,
  /(^|\.)chainstack\.com$/,
  /(^|\.)getblock\.(io|us)$/,
  /(^|\.)infura\.io$/,
  /(^|\.)helius-rpc\.com$/,
  /^(localhost|127\.0\.0\.1|\[::1\]):(8899|8900)$/, // a local validator's RPC and websocket (matched against host:port)
  /(^|\.)triton\.one$/,
  /(^|\.)jup\.ag$/,
  /(^|\.)jito\.wtf$/,
  /(^|\.)raydium\.io$/,
  // Any host at or under these, narrowed below to the two allowed uses: PumpPortal's /api/data stream and pump.fun/coin/ links.
  /(^|\.)pumpportal\.fun$/,
  /(^|\.)pump\.fun$/,
];

const RPC_METHODS = [
  "sendTransaction", "sendRawTransaction", "signTransaction", "signAllTransactions", "simulateTransaction", "requestAirdrop",
  "sendBundle", "sendSmartTransaction", "sendJitoBundle",
  "getLatestBlockhash", "getBalance", "getAccountInfo", "getTokenAccountsByOwner", "getSignaturesForAddress", "getTransaction",
  "getMultipleAccounts", "getTransactionsForAddress", "getProgramAccounts",
];

// The ADR 0002 Amendment allowance (see the header). Widening any of these three needs the Operator's say-so.
export const READ_ONLY_RPC_MODULE = "packages/core/src/study/helius.ts";
export const READ_ONLY_RPC_HOST = "mainnet.helius-rpc.com";
export const READ_ONLY_RPC_METHODS = ["getMultipleAccounts", "getTransactionsForAddress", "getAccountInfo", "getSignaturesForAddress", "getTransaction"];

const KEY_WORDS = /\b(Keypair|secretKey|privateKey|PRIVATE_KEY|mnemonic)\b/;

// Signing primitives of node:crypto and WebCrypto (an ed25519 signature is a wallet): none in the repo today, none allowed.
const SIGNING_PRIMITIVES = /\b(?:createPrivateKey|createSign|generateKeyPair(?:Sync)?|diffieHellman|webcrypto)\b|\bcrypto\.sign\s*\(|\bsubtle\.(?:sign|importKey|generateKey)\b|["'`]ed25519["'`]/i;

// A named import or destructuring of a signing primitive: `import { sign } from "node:crypto"`, `const { sign } = require("crypto")`.
const SIGNING_IMPORT = /\b(?:import|const|let|var)\s*\{(?=[^}]*\b(?:sign|createSign|createPrivateKey|generateKeyPair(?:Sync)?|diffieHellman|webcrypto|subtle)\b)[^}]*\}\s*(?:from\s*["'](?:node:)?crypto["']|=\s*(?:require\s*\(\s*["'](?:node:)?crypto["']\s*\)|(?:globalThis\.)?(?:web)?crypto\b))/;

// An RPC endpoint or a Helius setting read from the environment or config: the RPC host is pinned in the module, never configured.
const RPC_ENDPOINT_SETTING = /\b\w*RPC_?(?:URL|URI|ENDPOINT|HOST)\w*\b|\bHELIUS_(?!API_KEY\b)\w+/i;

const URL_RE = /\b(?:https?|wss?):\/\/[^\s"'`)<>\\]+/gi;

// A URL whose host is built at run time (`https://${h}/`, `https://api.${d}/`, `"https://" + h`, `["https://", h].join("")`) is
// invisible to the host bans. A bare scheme literal on its own (`startsWith("https://")`) is not a URL and is ignored; a loopback
// host with an interpolated port (`http://127.0.0.1:${port}`) is fine.
// The scheme may itself be missing or built (`${scheme}://${h}/`, `"//" + h`, `scheme + "://" + h`). The loopback exemption holds only
// when the closing `}` of the port interpolation is followed by `/`, `?`, `#`, a closing backtick or the end: anything else (`@`, `.`, a
// letter, `\`, whitespace, a quote, another `${`) would make the interpolation userinfo (`http://127.0.0.1:${p}@api.helius.xyz/`) or a longer host.
// The interpolation itself may hold no `{`, `}`, quote or backtick (`${`${a}`}`, `${ {}/1 }` end at an inner `}`): a plain expression only.
// This stops the nested forms, not every `}`: one supplied by a regex literal or a line comment inside the interpolation still passes
// outside the module (`${p.replace(/}/g,x)}@${h}/`); it is a documented residual in the header.
const DYNAMIC_HOST = /(?:\b(?:https?|wss?):\/\/|\}:\/\/|["'`]:?\/\/)(?!(?:localhost|127\.0\.0\.1):\$\{[^}`'"{]*\}(?:[/?#`]|$))(?:[^/?#\s"'`]*(?:\$\{|["'`]\s*\+)|["'`]\s*,[^\]\n]*\]\s*\.join)/i;
// Stricter, for the read-only module: also no bare scheme literal.
// (also a bare `"://"` or `"//"` literal, the separator in `[scheme, host].join("://")`).
const DYNAMIC_HOST_STRICT = /(?:\b(?:https?|wss?):\/\/|\}:\/\/|["'`]:?\/\/)(?:["'`]|[^/?#\s"'`]*(?:\$\{|["'`]\s*\+))/i;
// Files that already build a URL host at run time (test servers on a loopback port, fake hosts, a link normaliser). Frozen: a new
// file that needs this is a change to this list, which the reviewer sees. Never the read-only module.
const DYNAMIC_HOST_FILES = new Set<string>([
  "packages/core/src/egress-proxy.test.ts",
  "packages/core/src/sandbox.ts",
  "packages/core/src/signals.test.ts",
  "packages/core/src/study/guarded-fetch.test.ts",
  "packages/core/src/study/metadata.ts",
  "packages/core/src/study/wiring.test.ts",
  "packages/core/src/testing/fake-wrangler.mjs",
  "scripts/verify-boot.mjs",
]);

// Files where the bare apex name `pump.fun` or `pumpportal.fun` appears as prose (a comment, a UI note, a test title or fixture string)
// on the current tree. Frozen, ticket 23: the bare-host scan flags a banned hostname whatever precedes it, and these production and test
// files cannot drop the product name. Only the bare apex with nothing attached (no path, port, subdomain or interpolation) is exempt
// here; an RPC or trading host never is. Never the read-only module. A new file that needs this is a change to this list.
const BARE_APEX_FILES = new Set<string>([
  "apps/warroom/app/pages/study.vue",
  "packages/core/src/sources/pumpportal.test.ts",
  "packages/core/src/sources/pumpportal.ts",
  "packages/core/src/study/metadata.test.ts",
  "packages/core/src/study/store.test.ts",
  "packages/core/src/study/store.ts",
]);

// In the read-only module the word `method` may only appear as `method: "<one of the five reads>"` (or HTTP `method: "POST"`), so
// the module cannot export a generic `rpc(method: string, ...)`; only typed per-method wrappers fit. Write "RPC verb" in comments.
const METHOD_LITERAL = new RegExp(`["'\`]?\\bmethod["'\`]?\\s*:\\s*(["'\`])(?:${[...READ_ONLY_RPC_METHODS, "POST"].join("|")})\\1`, "g");
// Ways to assemble a method name or host at run time. A tripwire, not a proof: it only catches the obvious ones.
const MODULE_BANNED_CONSTRUCTS: [string, RegExp][] = [
  ["eval or Function constructor", /\beval\s*\(|\bFunction\s*\(/],
  ["string assembly (fromCharCode, atob, Reflect, Proxy)", /\bfromCharCode\b|\batob\s*\(|\bReflect\b|\bProxy\b/],
  ["concatenated string literals", /["'`]\s*\+\s*["'`]/],
  ["computed literal property key", /\[\s*["'`][^\]]*\]\s*:/],
  ["dynamic import", /\bimport\s*\(/],
];

const stripTrailingDots = (h: string): string => {
  let end = h.length;
  while (end > 0 && h[end - 1] === ".") end--;
  return h.slice(0, end);
};

// Undo the cheap disguises of a hostname so a bare-host scan sees what DNS sees: JS and HTML escapes, percent-encoding, full-width and
// compatibility forms, the ideographic full stop, zero-width characters. A tripwire, not a proof (see the header).
const codePointText = (cp: number): string | undefined => (cp >= 0x20 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff) ? String.fromCodePoint(cp) : undefined);
const normalizeForHosts = (text: string, identityEscapes = true): string =>
  text
    .replace(/\\\r?\n/g, "") // a line continuation inside a string literal
    .replace(/&period;/gi, ".")
    // leading zeros are free: \u{0000068} and &#x0000068; are "h"
    .replace(/\\u\{0*([0-9a-f]{1,6})\}|\\u([0-9a-f]{4})|\\x([0-9a-f]{2})/gi, (m, a?: string, b?: string, c?: string) => codePointText(parseInt(a ?? b ?? c ?? "0", 16)) ?? m)
    .replace(/&#x0*([0-9a-f]{1,6});|&#0*(\d{1,7});/gi, (m, h?: string, d?: string) => codePointText(h !== undefined ? parseInt(h, 16) : Number(d)) ?? m)
    // an identity escape is the character itself: "api.hel\ius" and "api\.helius" are api.helius (also a host in a regex)
    // (the view without it also runs, so a backslash in a path after an allowed host stays visible)
    .replace(identityEscapes ? /\\([^\\nrtbfv0-9xu\r\n])/g : /(?!)/g, "$1")
    .replace(/%([0-9a-f]{2})/gi, (m, h: string) => {
      const c = String.fromCharCode(parseInt(h, 16));
      return /[a-z0-9.-]/i.test(c) ? c : m;
    })
    .normalize("NFKC")
    .replace(/[。｡．]/g, ".")
    .replace(/[­​-‍⁠﻿]/g, "");

// Join string literals that are adjacent in the source, so a host split across them reads whole: "a" + "b", ["a", "b"], "a".concat("b"),
// `${"a"}b`, with a block comment in between dropped. Only literals next to each other: a variable in the middle (`"api." + sub +
// ".xyz"`) stays uncovered. `sep` is what an array join puts between the elements: "" for join(""), "." for `["api", "helius"].join(".")`.
const joinLiterals = (text: string, sep = ""): string => {
  let t = stripBlockComments(text)
    // also chained ('a'.concat('b').concat('c')), optional-chained (?.concat) and bracketed (['concat']). One `\s*` before each token, so
    // that no two whitespace runs are adjacent: a quote followed by n spaces costs O(n), not O(n^3).
    .replace(/["'`]\s*(?:\)\s*)?(?:\??\.\s*)?(?:concat|\[\s*["'`]concat["'`]\s*\])\s*\(\s*["'`]/g, "")
    .replace(/["'`]\s*\+\s*["'`]/g, "")
    .replace(/["'`]\s*,\s*["'`]/g, sep);
  // `${"a"}`, `${`a`}` and `${"a" + "b"}` (joined above), a few levels deep
  for (let i = 0; i < 4; i++) t = t.replace(/\$\{\s*(["'`])([^"'`$\\\n]*)\1\s*\}/g, "$2");
  return t;
};

// Drop /* ... */ in one linear pass (a lazy regex is quadratic on many unclosed `/*`).
const stripBlockComments = (text: string): string => {
  let out = "";
  let i = 0;
  for (;;) {
    const open = text.indexOf("/*", i);
    if (open === -1) break;
    const close = text.indexOf("*/", open + 2);
    if (close === -1) break;
    out += text.slice(i, open);
    i = close + 2;
  }
  return out + text.slice(i);
};

// A hostname-looking token (or `host:port`, `[::1]:port`), whatever precedes it: after a scheme, `//`, `@`, a quote, a space or nothing.
const HOST_TOKEN = /(\[::1\]|[a-z0-9-]+(?:\.+[a-z0-9-]+)*)(\.*)(?::(\d{1,5}))?/gi;

// ADR 0002 rule 2 for a banned host that is not inside a URL with a literal scheme, with the same allowances as for URLs.
function bareHostViolations(file: string, text: string, readOnlyRpc: boolean, already: string[]): string[] {
  const found: string[] = [];
  for (const m of text.matchAll(HOST_TOKEN)) {
    const host = stripTrailingDots(m[1]!.toLowerCase());
    const port = m[3];
    const hostPort = port === undefined ? host : `${host}:${port}`;
    if (!host.includes(".") && port === undefined) continue;
    if (!BANNED_HOSTS.some((r) => r.test(host) || r.test(hostPort))) continue;
    // A URL with a literal scheme was judged already (and reported if bad): do not report it twice.
    if (already.some((v) => v.includes(": endpoint ") && v.toLowerCase().includes(host))) continue;
    const start = m.index;
    const end = start + m[0].length;
    const before = text.slice(0, start);
    // A backslash is a slash to a URL parser (http, https): it continues the rest, except before n/r/t (a newline, CR or tab escape in a
    // string) or a quote (an escaped quote), which end it.
    const rest = /^(?:[^\s"'`)<>\\]|\\(?![nrt"'`]))*/.exec(text.slice(end))![0];
    const path = rest.split(/[?#]/)[0]!;
    // No trailing dot, except ONE sentence-ending period (`... mainnet.helius-rpc.com. Read-only.`): followed by whitespace or the end of
    // the text, and not right after `/` (so `//` or a scheme), `@` or a quote: a host written as a URL or as the whole string literal keeps
    // its trailing-dot ban (ticket 18). A dot after other text inside a string (`" host. "`) is accepted: a host with a space after it is no host.
    const sentenceDot = m[2] === "." && port === undefined && /^(?:\s|$)/.test(text.slice(end)) && !/["'`/@]$/.test(before);
    const plain = port === undefined && (m[2] === "" || sentenceDot);
    // `pump.fun/coin/../api/trade` would normalise to /api/trade in a URL: a dot segment, a backslash or an empty segment is never the allowance.
    const tidy = !/(?:^|\/)\.\.?(?:\/|$)|\\|\/\//.test(path);
    const allowed =
      port === undefined &&
      ((tidy && host === "pumpportal.fun" && (path === "/api/data" || path.startsWith("/api/data/"))) ||
        (tidy && host === "pump.fun" && path.startsWith("/coin/")) ||
        // the pinned read-only host: the exact host, as a plain token or after a literal `https://` (never `//`, `${s}://` or userinfo), path "/";
        // one sentence period after the path (`https://mainnet.helius-rpc.com/.`) is dropped, as the URL scan does
        (readOnlyRpc && plain && host === READ_ONLY_RPC_HOST && !/[@/\\]$/.test(before.replace(/https:\/\/$/i, "")) && /^(?:[,;!?\]}:]*|\/?(?:[?#].*)?)$/.test(rest.replace(/\.$/, ""))) ||
        // the bare apex name as prose in a frozen file
        (!readOnlyRpc && BARE_APEX_FILES.has(file.split(sep).join("/")) && plain && (host === "pump.fun" || host === "pumpportal.fun") && !/[/@\\]$/.test(before) && /^[,;!?\]}:]*$/.test(rest)));
    const msg = `${file}: bare banned host ${hostPort}`;
    if (!allowed && !found.includes(msg)) found.push(msg);
  }
  // A local validator's port with the host built elsewhere (`${host}:8899`): the port alone is the tell.
  if (/:(?:8899|8900)(?!\d)/.test(text) && ![...already, ...found].some((v) => /:(?:8899|8900)(?!\d)/.test(v))) found.push(`${file}: bare banned host :8899/:8900`);
  return found;
}

export function violations(file: string, text: string): string[] {
  const out: string[] = [];
  const readOnlyRpc = file.split(sep).join("/") === READ_ONLY_RPC_MODULE;
  if (file.endsWith("package.json")) {
    const pkg = JSON.parse(text) as Record<string, Record<string, string> | undefined>;
    for (const field of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
      for (const name of Object.keys(pkg[field] ?? {})) if (BANNED_PACKAGES.some((r) => r.test(name))) out.push(`${file}: dependency ${name}`);
    }
    return out;
  }
  for (const m of text.matchAll(/(?:\bfrom\s*|\bimport\s*(?:\(\s*)?|\brequire\s*\(\s*)["']([^"']+)["']/g)) {
    if (BANNED_PACKAGES.some((r) => r.test(m[1]!))) out.push(`${file}: import ${m[1]}`);
  }
  const urlEndpoints = (src: string): string[] => {
    const bad: string[] = [];
    for (const m of src.matchAll(URL_RE)) {
      // Judge the literal part before the first `${`: `https://api.helius.xyz${path}` and `https://pumpportal.fun:${port}` must not parse
      // as an unknown host. If the interpolation follows the host or a path segment (not a `/`, `?` or `#`), it can extend them: not allowed.
      const cut = m[0].indexOf("${");
      const head = (cut === -1 ? m[0] : m[0].slice(0, cut)).replace(/[.,;]+$/, "");
      const extended = cut !== -1 && !head.endsWith("/") && !head.includes("?") && !head.includes("#");
      let u: URL;
      try {
        u = new URL(head);
      } catch {
        continue;
      }
      // `new URL` keeps a trailing dot (`host.com.`, also from `%2e` and the ideographic full stop), which is the same host to DNS.
      const host = stripTrailingDots(u.hostname);
      const hostPort = u.port === "" ? host : `${host}:${u.port}`;
      if (!BANNED_HOSTS.some((r) => r.test(host) || r.test(hostPort))) continue;
      const ok = !extended && ((host === "pumpportal.fun" && (u.pathname === "/api/data" || u.pathname.startsWith("/api/data/"))) || (host === "pump.fun" && u.pathname.startsWith("/coin/")));
      // The pinned form only: the exact host (no trailing dot), https, no port or userinfo, path "/".
      const readOnly = readOnlyRpc && !extended && u.protocol === "https:" && u.hostname === READ_ONLY_RPC_HOST && u.port === "" && u.username === "" && u.password === "" && u.pathname === "/";
      if (!ok && !readOnly) bad.push(`${file}: endpoint ${u.href}`);
    }
    return bad;
  };
  out.push(...urlEndpoints(text));
  // The same scan on the text with adjacent string literals joined: `"https://api.helius." + "xyz/"`.
  const joined = joinLiterals(text);
  if (joined !== text) for (const v of urlEndpoints(joined)) if (!out.includes(v)) out.push(v);
  // A banned hostname anywhere in the text whatever precedes it (no literal scheme: `${scheme}://h`, `"//h"`, `"ht" + "tps://h"`, a bare
  // constant), disguised or not. Apex pump.fun and pumpportal.fun as prose are exempt only in BARE_APEX_FILES.
  // Views of the text, each scanned on its own (a view only ever ADDS findings): with the identity escapes kept (a backslash stays a path
  // separator), and, with them undone, as is and with `\n`, `\r` and `\t` escapes dropped (a URL parser drops LF, CR and TAB from a URL), each
  // joined across adjacent literals with "" and with ".".
  const norm = normalizeForHosts(text);
  const views = [norm, norm.replace(/\\[nrt]/g, "")].flatMap((t) => [t, joinLiterals(t), joinLiterals(t, ".")]);
  for (const t of new Set([normalizeForHosts(text, false), ...views])) for (const v of bareHostViolations(file, t, readOnlyRpc, out)) if (!out.includes(v)) out.push(v);
  const normFile = file.split(sep).join("/");
  if (readOnlyRpc ? DYNAMIC_HOST_STRICT.test(text) || DYNAMIC_HOST.test(text) : DYNAMIC_HOST.test(text) && !DYNAMIC_HOST_FILES.has(normFile)) out.push(`${file}: URL with a host built at run time`);
  if (!readOnlyRpc && /jsonrpc/i.test(text)) out.push(`${file}: JSON-RPC request outside ${READ_ONLY_RPC_MODULE}`);
  const setting = RPC_ENDPOINT_SETTING.exec(text);
  if (setting) out.push(`${file}: RPC endpoint setting ${setting[0]}`);
  for (const method of RPC_METHODS) {
    if (readOnlyRpc && READ_ONLY_RPC_METHODS.includes(method)) continue;
    if (new RegExp(`["'\`]${method}["'\`]`).test(text)) out.push(`${file}: RPC method "${method}"`);
  }
  if (readOnlyRpc) {
    if (/\bmethod\b/.test(text.replace(METHOD_LITERAL, ""))) out.push(`${file}: JSON-RPC method that is not a literal`);
    for (const [name, re] of MODULE_BANNED_CONSTRUCTS) if (re.test(text)) out.push(`${file}: ${name}`);
  }
  const key = KEY_WORDS.exec(text);
  if (key) out.push(`${file}: key handling ${key[0]}`);
  const sign = SIGNING_PRIMITIVES.exec(text) ?? SIGNING_IMPORT.exec(text);
  if (sign) out.push(`${file}: signing primitive ${sign[0]}`);
  return out;
}

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const SKIP_DIRS = new Set(["node_modules", ".git", ".data", ".scratch", ".claude", ".nuxt", ".output", "dist", "fixtures"]);
const SOURCE_EXT = /\.(ts|mts|cts|tsx|mjs|cjs|js|jsx|vue)$/;
const SELF = join("packages", "core", "src", "adr-0002.test.ts");

function sourceFiles(dir: string, acc: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) sourceFiles(join(dir, e.name), acc);
    } else if (SOURCE_EXT.test(e.name) || e.name === "package.json") acc.push(join(dir, e.name));
  }
  return acc;
}

describe("ADR 0002: argus never touches a chain", () => {
  it("no source or manifest has a chain SDK, an RPC or transaction endpoint, a chain RPC method or key handling", () => {
    const files = sourceFiles(ROOT).filter((f) => relative(ROOT, f) !== SELF);
    expect(files.length).toBeGreaterThan(30); // the walk found the repo
    const found = files.flatMap((f) => violations(relative(ROOT, f), readFileSync(f, "utf8")));
    expect(found).toEqual([]);
  });

  it("every file on the frozen dynamic-host list still exists", () => {
    const files = new Set(sourceFiles(ROOT).map((f) => relative(ROOT, f).split(sep).join("/")));
    for (const f of DYNAMIC_HOST_FILES) expect(files.has(f), f).toBe(true);
  });

  it("every file on the frozen bare-apex list still exists", () => {
    const files = new Set(sourceFiles(ROOT).map((f) => relative(ROOT, f).split(sep).join("/")));
    for (const f of BARE_APEX_FILES) expect(files.has(f), f).toBe(true);
  });

  it("the walk covers the read-only Sources that mention pump.fun, PumpPortal and DexScreener", () => {
    const files = sourceFiles(ROOT).map((f) => relative(ROOT, f));
    for (const f of ["pumpportal.ts", "dexscreener.ts"]) expect(files).toContain(join("packages", "core", "src", "sources", f));
  });

  describe("the rule itself", () => {
    it("allows PumpPortal's data stream, pump.fun coin links and the DexScreener API", () => {
      const src = [
        'const STREAM_URL = "wss://pumpportal.fun/api/data";',
        "const link = `https://pump.fun/coin/${mint}`;",
        'const API_BASE = "https://api.dexscreener.com";',
        'new WebSocket("wss://pumpportal.fun/api/data");',
      ].join("\n");
      expect(violations("ok.ts", src)).toEqual([]);
    });

    it("flags chain SDK imports and dependencies", () => {
      expect(violations("a.ts", 'import { Connection } from "@solana/web3.js";')).toHaveLength(1);
      expect(violations("a.ts", 'const { PumpSdk } = require("@pump-fun/pump-sdk");')).toHaveLength(1);
      expect(violations("a.ts", 'await import("@coral-xyz/anchor");')).toHaveLength(1);
      expect(violations("package.json", JSON.stringify({ dependencies: { "@solana/web3.js": "1" } }))).toHaveLength(1);
      expect(violations("package.json", JSON.stringify({ dependencies: { parse5: "8" } }))).toEqual([]);
    });

    it("flags RPC, trading and transaction endpoints", () => {
      for (const url of [
        "https://api.mainnet-beta.solana.com",
        "https://mainnet.helius-rpc.com/?api-key=x",
        "https://pumpportal.fun/api/trade?api-key=x",
        "https://pumpportal.fun/api/trade-local",
        "https://frontend-api-v3.pump.fun/coins",
        "https://pump.fun/api/ipfs",
        "https://quote-api.jup.ag/v6/swap",
        "wss://api.mainnet-beta.solana.com",
      ]) expect(violations("e.ts", `fetch("${url}")`), url).toHaveLength(1);
    });

    it("flags any other pump.fun or pumpportal.fun host, and the RPC providers", () => {
      for (const url of [
        "https://api.pump.fun/trade",
        "https://swap-api.pump.fun/v1/quote",
        "https://www.pumpportal.fun/api/trade",
        "https://pumpportal.fun/api/create-wallet",
        "https://pumpportal.fun/api/datax",
        "https://x.rpcpool.com/abc",
        "https://solana-mainnet.core.chainstack.com/abc",
        "https://go.getblock.io/abc",
        "https://mainnet.infura.io/v3/abc",
        "https://abc.solana-mainnet.quiknode.pro/abc",
        "https://abc.solana-mainnet.quicknode.com/abc",
        "https://solana-mainnet.g.alchemy.com/v2/abc",
        "http://localhost:8899",
        "ws://127.0.0.1:8900",
      ]) expect(violations("e.ts", `const u = "${url}";`), url).toHaveLength(1);
      expect(violations("ok.ts", 'const u = "http://localhost:3000"; const v = "http://localhost:3100";')).toEqual([]);
    });

    it("scans .mts, .cts, .tsx, .cjs and .jsx files too", () => {
      for (const name of ["a.mts", "a.cts", "a.tsx", "a.cjs", "a.mjs", "a.jsx", "a.vue", "a.ts", "a.js"]) expect(SOURCE_EXT.test(name), name).toBe(true);
      expect(SOURCE_EXT.test("a.md")).toBe(false);
    });

    it("catches synthetic offending files", () => {
      const sendTx = [
        'import { Connection, Keypair } from "@solana/web3.js";',
        'const c = new Connection("https://api.mainnet-beta.solana.com");',
        "const kp = Keypair.fromSecretKey(secretKey);",
        'await c.sendTransaction(tx);',
        'await fetch(c.url, { body: JSON.stringify({ method: "sendTransaction", params: [] }) });',
      ].join("\n");
      const found = violations("bad/send.mts", sendTx);
      expect(found.some((v) => v.includes("import @solana/web3.js"))).toBe(true);
      expect(found.some((v) => v.includes("endpoint https://api.mainnet-beta.solana.com"))).toBe(true);
      expect(found.some((v) => v.includes('RPC method "sendTransaction"'))).toBe(true);
      expect(found.some((v) => v.includes("key handling"))).toBe(true);
      const trade = 'const r = await fetch("https://pumpportal.fun/api/trade?api-key=" + k, { method: "POST", body: JSON.stringify({ action: "buy" }) });';
      expect(violations("bad/trade.cjs", trade)).toHaveLength(1);
      const sdk = 'const { PumpSdk } = require("@pump-fun/pump-sdk");\nmodule.exports = PumpSdk;';
      expect(violations("bad/sdk.cjs", sdk)).toHaveLength(1);
    });

    describe("the Amendment's read-only RPC allowance", () => {
      const M = READ_ONLY_RPC_MODULE;
      const HOST = `https://${READ_ONLY_RPC_HOST}/?api-key=\${key}`;
      const reader = [
        `const ENDPOINT = \`${HOST}\`;`,
        ...READ_ONLY_RPC_METHODS.map((m) => `rpc("${m}", [accounts]);`),
      ].join("\n");

      it("is one file, one https host and five read methods", () => {
        expect(M).toBe("packages/core/src/study/helius.ts");
        expect(READ_ONLY_RPC_HOST).toBe("mainnet.helius-rpc.com");
        expect([...READ_ONLY_RPC_METHODS].sort()).toEqual(["getAccountInfo", "getMultipleAccounts", "getSignaturesForAddress", "getTransaction", "getTransactionsForAddress"]);
        for (const m of READ_ONLY_RPC_METHODS) expect(RPC_METHODS).toContain(m); // banned by default, allowed only in the module
      });

      it("passes in the allowed module", () => {
        expect(violations(M, reader)).toEqual([]);
        expect(violations(M, `fetch("https://${READ_ONLY_RPC_HOST}")`)).toEqual([]);
      });

      it("fires for the same code in any other file", () => {
        for (const f of [
          "packages/core/src/study/helius2.ts",
          "packages/core/src/study/helius.test.ts",
          "packages/core/src/helius.ts",
          "packages/core/src/study/sub/helius.ts",
          "apps/warroom/server/utils/helius.ts",
          "packages/core/src/study/helius.mjs",
          "x/packages/core/src/study/helius.ts",
          "helius.ts",
        ]) {
          const found = violations(f, reader);
          expect(found.some((v) => v.includes("endpoint https://mainnet.helius-rpc.com")), f).toBe(true);
          for (const m of READ_ONLY_RPC_METHODS) expect(found.some((v) => v.includes(`RPC method "${m}"`)), `${f} ${m}`).toBe(true);
        }
      });

      it("fires inside the allowed module for any other host, scheme, port, userinfo or path", () => {
        for (const url of [
          "https://sender.helius-rpc.com/fast",
          "https://api.helius.xyz/v0/transactions?api-key=x",
          "https://devnet.helius-rpc.com/?api-key=x",
          "http://mainnet.helius-rpc.com/",
          "wss://mainnet.helius-rpc.com/?api-key=x",
          "https://mainnet.helius-rpc.com:8899/",
          "https://user:pw@mainnet.helius-rpc.com/",
          "https://mainnet.helius-rpc.com/v0/send",
          "https://www.helius.dev/docs",
          "https://api.mainnet-beta.solana.com",
          "https://solana-mainnet.g.alchemy.com/v2/abc",
          "https://x.rpcpool.com/abc",
          "https://mainnet.infura.io/v3/abc",
          "http://localhost:8899",
          "https://pumpportal.fun/api/trade-local",
          "https://quote-api.jup.ag/v6/swap",
          "https://mainnet.block-engine.jito.wtf/api/v1/bundles",
        ]) expect(violations(M, `fetch("${url}")`), url).toHaveLength(1);
      });

      it("fires inside the allowed module for write, signing and other wallet or tx-building methods", () => {
        for (const method of [
          "sendTransaction", "sendRawTransaction", "signTransaction", "signAllTransactions", "simulateTransaction", "requestAirdrop",
          "sendBundle", "sendSmartTransaction", "sendJitoBundle", "getLatestBlockhash", "getBalance", "getTokenAccountsByOwner", "getProgramAccounts",
        ]) {
          expect(violations(M, `${reader}\nrpc("${method}", [x]);`), method).toEqual([`${M}: RPC method "${method}"`]);
        }
      });

      it("fires inside the allowed module for SDKs, keys and wallets", () => {
        expect(violations(M, `${reader}\nimport { Connection } from "@solana/web3.js";`)).toEqual([`${M}: import @solana/web3.js`]);
        expect(violations(M, `${reader}\nimport { Helius } from "helius-sdk";`)).toEqual([`${M}: import helius-sdk`]);
        expect(violations(M, `${reader}\nimport { Helius } from "@helius-labs/sdk";`)).toHaveLength(1);
        expect(violations(M, `${reader}\nconst w = require("@pump-fun/pump-sdk");`)).toHaveLength(1);
        for (const key of ["const kp = Keypair.generate();", "const s = wallet.secretKey;", "const p = privateKey;", "process.env.PRIVATE_KEY", "const m = mnemonic;"]) {
          expect(violations(M, `${reader}\n${key}`), key).toHaveLength(1);
        }
        expect(violations("packages/core/src/study/package.json", JSON.stringify({ dependencies: { "helius-sdk": "1" } }))).toHaveLength(1);
        expect(violations("package.json", JSON.stringify({ dependencies: { "@solana/web3.js": "1" } }))).toHaveLength(1);
      });

      it("matches the module path exactly, not by prefix", () => {
        expect(violations(M.split("/").join(sep), reader)).toEqual([]);
        expect(violations(`${M}.bak.ts`, reader).length).toBeGreaterThan(0);
      });

      it("fires for a trailing dot, %2e or an ideographic full stop on any banned host, in any file", () => {
        for (const host of [
          "mainnet.helius-rpc.com", "sender.helius-rpc.com", "api.mainnet-beta.solana.com", "quote-api.jup.ag",
          "mainnet.block-engine.jito.wtf", "x.rpcpool.com", "api.pump.fun",
        ]) {
          for (const tail of [".", "%2e", "。", "..", "%2e."]) {
            const src = `fetch("https://${host}${tail}/x")`;
            expect(violations("other.ts", src), src).toHaveLength(1);
            expect(violations(M, src.replace("/x", "/")), `${M} ${src}`).toHaveLength(1);
          }
        }
        for (const src of ["wss://pumpportal.fun./api/trade", "https://pumpportal.fun%2e/api/trade", 'new WebSocket("wss://pumpportal.fun。/api/trade")', "https://pump.fun./api/ipfs", "http://localhost.:8899", "http://127.0.0.1.:8899", "http://localhost%2e:8900"]) {
          expect(violations("other.ts", src), src).toHaveLength(1);
        }
        // the pinned host itself must be spelled exactly: a trailing-dot spelling is not the allowance
        expect(violations(M, 'fetch("https://mainnet.helius-rpc.com./")')).toHaveLength(1);
        // and the allowed uses keep working with the dot
        expect(violations("ok.ts", 'new WebSocket("wss://pumpportal.fun./api/data"); const l = "https://pump.fun./coin/abc";')).toEqual([]);
      });

      it("fires for a host built at run time, outside a small frozen list of files", () => {
        for (const src of [
          "fetch(`https://${HOST}/`)",
          "fetch(`wss://${process.env.X}`)",
          'fetch("https://" + host + "/")',
          "fetch(['https://', host].join(''))",
          "const base = `https://${a}.${b}/`;",
          "fetch('http://' + h)",
        ]) {
          expect(violations("new/file.ts", src), src).toEqual(["new/file.ts: URL with a host built at run time"]);
          expect(violations(M, src), `${M} ${src}`.slice(0, 80)).toContain(`${M}: URL with a host built at run time`);
        }
        // a loopback port or a path may be interpolated, and a bare scheme literal is not a URL; a partial host may not
        expect(violations("t.ts", "const u = `http://127.0.0.1:${port}/x`; const v = `ws://localhost:${port}`; const w = `https://x.com/${path}`;")).toEqual([]);
        expect(violations("t.ts", 'if (u.startsWith("https://") || u.startsWith("wss://")) go(); const all = ["https://", "wss://"];')).toEqual([]);
        for (const src of ["fetch(`https://api.${d}/`)", 'fetch("https://api." + d)', "fetch(`https://mainnet.helius-rpc.com.${d}/`)", "fetch(`https://mainnet.helius-rpc.com${path}`)", "fetch(`https://pump.${tld}/coin/x`)", "fetch(`https://mainnet.helius-rpc.${tld}/`)"]) {
          expect(violations(M, src), src).toContain(`${M}: URL with a host built at run time`);
          expect(violations("other.ts", src), src).toContain("other.ts: URL with a host built at run time");
        }
        // the module takes no bare scheme literal either
        expect(violations(M, 'const s = "https://";')).toContain(`${M}: URL with a host built at run time`);
        expect(DYNAMIC_HOST_FILES.has(M)).toBe(false);
        expect(violations([...DYNAMIC_HOST_FILES][0]!, "fetch(`https://${HOST}/`)")).toEqual([]);
      });

      it("fires for a banned host followed by an interpolation, in every file", () => {
        const endpoint = (found: string[]) => found.some((v) => v.includes(": endpoint "));
        for (const host of ["https://api.helius.xyz", "https://sender.helius-rpc.com", "https://mainnet.helius-rpc.com", "https://pumpportal.fun", "wss://pumpportal.fun", "https://pump.fun", "https://mainnet.block-engine.jito.wtf", "https://quote-api.jup.ag", "https://api.mainnet-beta.solana.com", "https://x.rpcpool.com", "http://localhost:8899"]) {
          for (const tail of ["${path}", "/${path}", ":${port}", ":${port}/x", "${path}/x", "/api/trade${q}", ".${tld}/"]) {
            const src = `fetch(\`${host}${tail}\`)`;
            if (host.startsWith("http://localhost") && tail.startsWith(":")) continue; // a second port on the banned local validator
            if (host === "https://pump.fun" && tail === "/${path}") continue; // pump.fun/<anything> is only allowed under /coin/
            expect(endpoint(violations("other.ts", src)), `other.ts ${src}`).toBe(true);
            if (host !== "https://mainnet.helius-rpc.com" || tail !== "/${path}") expect(endpoint(violations(M, src)) || violations(M, src).length > 0, `${M} ${src}`).toBe(true);
          }
        }
        // the allowed uses survive an interpolation after a slash
        expect(violations("ok.ts", "const l = `https://pump.fun/coin/${mint}`; const s = `wss://pumpportal.fun/api/data/${x}`;")).toEqual([]);
        // but not an interpolation that extends the last path segment
        expect(endpoint(violations("bad.ts", "const s = `wss://pumpportal.fun/api/data${x}`;"))).toBe(true);
        expect(endpoint(violations("bad.ts", "const l = `https://pump.fun/coin${x}`;"))).toBe(true);
        // the pinned URL with the key in the query is still the allowance
        expect(violations(M, "fetch(`https://mainnet.helius-rpc.com/?api-key=${key}`)")).toEqual([]);
      });

      describe("ticket 23: residual bypasses", () => {
        const BARE = ": bare banned host ";
        const bare = (found: string[]) => found.some((v) => v.includes(BARE));
        // a banned host found either as a URL with a (joined) literal scheme or as a bare hostname
        const hit = (found: string[]) => found.some((v) => v.includes(BARE) || v.includes(": endpoint "));
        const DYN = (f: string) => `${f}: URL with a host built at run time`;

        it("(a) fires for a banned host whose scheme is not a literal, in every file", () => {
          for (const src of [
            "fetch(`${scheme}://api.helius.xyz/`)",
            'fetch("//api.helius.xyz/")',
            'fetch("ht" + "tps://api.helius.xyz/")',
            'fetch("ht" + "tps://" + "api.helius.xyz/")',
            "const u = `${proto}//mainnet.helius-rpc.com/`;",
            'const h = "api.mainnet-beta.solana.com"; fetch(`${s}://${h}/`);',
          ]) {
            expect(hit(violations("other.ts", src)), `other.ts ${src}`).toBe(true);
            expect(hit(violations(M, src)), `${M} ${src}`).toBe(true);
          }
          // the pinned host is only the allowance in the module, and only as the exact host with path "/" (or a query)
          expect(bare(violations("other.ts", `const h = "${READ_ONLY_RPC_HOST}";`))).toBe(true);
          expect(violations(M, `const HOST = "${READ_ONLY_RPC_HOST}"; // reads ${READ_ONLY_RPC_HOST}, read-only\nconst u = \`https://${READ_ONLY_RPC_HOST}/?api-key=\${key}\`;`)).toEqual([]);
          for (const src of ["//mainnet.helius-rpc.com/", "//mainnet.helius-rpc.com/?api-key=x", "${s}://mainnet.helius-rpc.com/", "http://mainnet.helius-rpc.com/", "https://u@mainnet.helius-rpc.com/", "/mainnet.helius-rpc.com/"]) {
            expect(violations(M, `fetch("${src}")`).length, `${M} ${src}`).toBeGreaterThan(0);
          }
          for (const src of ["//mainnet.helius-rpc.com/v0/send", "//mainnet.helius-rpc.com:8899/", "//mainnet.helius-rpc.com.", "//mainnet.helius-rpc.com${path}", "//mainnet.helius-rpc.com/${path}", "//user@mainnet.helius-rpc.com/", "//devnet.helius-rpc.com/"]) {
            expect(bare(violations(M, `fetch("${src}")`)), `${M} ${src}`).toBe(true);
          }
          // the other allowed uses stay allowed without a literal scheme
          expect(violations("ok.ts", 'new WebSocket("//pumpportal.fun/api/data"); const l = `//pump.fun/coin/${m}`; const s = `${p}://pumpportal.fun/api/data`;')).toEqual([]);
          // a dot segment or a backslash cannot ride an allowed prefix (a URL parser would normalise it away)
          for (const src of ["//pump.fun/coin/../api/ipfs", "//pump.fun/coin/%2e%2e/api/ipfs", "//pumpportal.fun/api/data/../trade", "//pumpportal.fun/api/data/./../../api/trade", "//pump.fun/coin/..\\api/ipfs", "${s}://pump.fun/coin//x"]) {
            expect(bare(violations("other.ts", `fetch("${src}")`)), src).toBe(true);
          }
          // the module takes no bare scheme separator either: [scheme, host].join("://")
          for (const src of ['fetch([scheme, HOST].join("://"))', 'fetch(scheme + "://" + HOST)', 'const sep = "//"; fetch(scheme + sep + HOST)']) {
            expect(violations(M, src), `${M} ${src}`).toContain(DYN(M));
          }
          expect(violations("other.ts", 'const [scheme, rest] = url.split("://"); const p = "//";')).toEqual([]);
          for (const src of ["//pumpportal.fun/api/trade", "//pump.fun/api/ipfs", "//pump.fun/coin${x}", "//pumpportal.fun/api/data${x}", "//pumpportal.fun${x}", "//api.pump.fun/coin/x", "//pump.fun:443/coin/x"]) {
            expect(bare(violations("other.ts", `fetch("${src}")`)), src).toBe(true);
          }
        });

        it("(a) covers every banned host, not just Helius", () => {
          for (const host of ["api.mainnet-beta.solana.com", "x.solana.org", "x.rpcpool.com", "go.getblock.io", "mainnet.infura.io", "quote-api.jup.ag", "mainnet.block-engine.jito.wtf", "api.raydium.io", "x.triton.one", "x.g.alchemy.com", "x.ankr.com", "x.quiknode.pro", "x.quicknode.com", "x.chainstack.com", "api.pump.fun", "www.pumpportal.fun", "localhost:8899", "127.0.0.1:8900", "[::1]:8899"]) {
            expect(bare(violations("other.ts", `fetch(\`\${s}://${host}/x\`)`)), host).toBe(true);
          }
          // other hosts and look-alikes are not banned hosts
          expect(violations("ok.ts", 'const a = "api.dexscreener.com"; const b = "notsolana.com"; const c = "solana.com.example.org"; const d = "localhost:3000";')).toEqual([]);
        });

        it("(a) is not fooled by case, a trailing dot, %2e, escapes, full-width forms, zero-width characters or entities", () => {
          for (const src of [
            'fetch("//API.HELIUS.XYZ/")',
            'fetch("//api.helius.xyz./")',
            'fetch("//api.helius.xyz../")',
            'fetch("//api%2ehelius%2Exyz/")',
            'fetch("//api.hel%69us.xyz/")',
            'fetch("//api.\\x68elius.xyz/")',
            'fetch("//api.\\u0068elius.xyz/")',
            'fetch("//api.\\u{68}elius.xyz/")',
            'fetch("//ａｐｉ．ｈｅｌｉｕｓ．ｘｙｚ/")',
            'fetch("//api.helius。xyz/")',
            'fetch("//api.hel​ius.xyz/")',
            'fetch("//api.hel­ius.xyz/")',
            '<a href="//api&#46;helius.xyz/">',
            '<a href="//api&#x2e;helius.xyz/">',
            'fetch("//user:pw@api.helius.xyz/")',
            'fetch("//api.helius.xyz:443/")',
            'fetch("//x@y:z@api.helius.xyz/")',
            'fetch("localhost:8899")',
            'fetch("LOCALHOST.:8899")',
          ]) expect(bare(violations("other.ts", src)), src).toBe(true);
          // inside a URL, a banned host in the path or query is still found
          expect(bare(violations("other.ts", 'fetch("https://redirect.example/?to=https://api.helius.xyz/")'))).toBe(true);
          expect(bare(violations("other.ts", 'fetch("https://redirect.example/go/api.helius.xyz")'))).toBe(true);
        });

        it("(a) is not fooled by a host split across literals or lines", () => {
          for (const src of [
            'fetch("//api.helius" + ".xyz/")',
            'fetch("//api." + "helius." + "xyz/")',
            'fetch("//api.helius" /* split */ + ".xyz/")',
            'fetch("//api.helius\\\n.xyz/")',
            'fetch("//api\\.helius\\.xyz/")',
            "const re = /^https?:\\/\\/api\\.helius\\.xyz/;",
            'fetch("//api\\u002ehelius.xyz/")',
            '<a href="//api&period;helius.xyz/">',
            'fetch(["api", "helius", "xyz"].join("."))',
            'fetch(`http://${h}:8899`)',
            "fetch(`http://${host}:8900/`)",
            'fetch("//api.helius" +\n  ".xyz/")',
            'fetch("//api.helius"\n  + ".xyz/")',
            "fetch(`//api.helius` + `.xyz/`)",
            'fetch(["//api.helius", ".xyz/"].join(""))',
            'fetch(["//api.helius",\n ".xyz/"].join(""))',
            'fetch("//api.helius".concat(".xyz/"))',
            'fetch("//api.helius".concat(".", "xyz/"))',
            'fetch(`//${"api.helius"}.${"xyz"}/`)',
            'fetch("https://" + "api.hel" + "ius.xyz/")',
          ]) expect(hit(violations("other.ts", src)), src).toBe(true);
        });

        it("(a) fires for a host or scheme assembled around a literal scheme separator, in every file", () => {
          for (const src of ["fetch(`${scheme}://${host}/`)", "fetch(`${scheme}://api.${d}/`)", 'fetch(scheme + "://" + host)', 'fetch(`//${host}/`)', 'fetch("//" + host)', "fetch(`${scheme}://${host}`)"]) {
            expect(violations("new/file.ts", src), src).toContain(DYN("new/file.ts"));
            expect(violations(M, src), `${M} ${src}`).toContain(DYN(M));
          }
          // a comment's `//` and a `//` in the middle of a string are not a protocol-relative URL
          expect(violations("t.ts", 'const a = 1; // ${not} a url\nconst re = /\\/\\/x/; const p = "a//b";')).toEqual([]);
          expect(violations("t.ts", "const u = `${base}/x`; const w = `${a}://`.length;")).toEqual([]);
        });

        it("(a) keeps the bare apex names pump.fun and pumpportal.fun as prose only in the frozen files", () => {
          const prose = 'const note = "pump.fun creates seen"; /** Not a pump.fun launch. */ const t = `New token on pump.fun: ${token}`; // launched on pump.fun. Mint.';
          // frozen: exactly these six files, no spare slot
          expect([...BARE_APEX_FILES].sort()).toEqual([
            "apps/warroom/app/pages/study.vue",
            "packages/core/src/sources/pumpportal.test.ts",
            "packages/core/src/sources/pumpportal.ts",
            "packages/core/src/study/metadata.test.ts",
            "packages/core/src/study/store.test.ts",
            "packages/core/src/study/store.ts",
          ]);
          expect(violations("other.ts", prose).some((v) => v.includes(BARE))).toBe(true);
          expect(violations(M, prose).some((v) => v.includes(BARE))).toBe(true);
          const [f] = [...BARE_APEX_FILES];
          expect(violations(f!, prose)).toEqual([]);
          // never the read-only module, and only the bare apex: no path, port, subdomain, interpolation or RPC host
          expect(BARE_APEX_FILES.has(M)).toBe(false);
          for (const src of ['fetch("//pump.fun/api/ipfs")', 'fetch("//pumpportal.fun/api/trade")', "fetch(`//pump.fun${p}`)", 'fetch("//pump.fun:443")', 'fetch("//api.pump.fun")', 'fetch("//api.helius.xyz")', 'fetch("//pump.fun./api/ipfs")', 'fetch("//pump.fun" + "/api/trade")', 'const s = "pumpportal.fun.";', "const s = 'pump.fun.';"]) {
            expect(violations(f!, src).length, `${f} ${src}`).toBeGreaterThan(0);
          }
        });

        it("(b) fires for userinfo smuggled after a loopback port interpolation", () => {
          for (const src of [
            "fetch(`http://127.0.0.1:${p}@api.helius.xyz/`)",
            "fetch(`http://127.0.0.1:${p}@evil.example/`)",
            "fetch(`http://localhost:${p}@evil.example/`)",
            "fetch(`ws://localhost:${p}@evil.example`)",
            "fetch(`http://127.0.0.1:${a}${b}/`)",
            "fetch(`http://127.0.0.1:${a}${b}@evil.example/`)",
            "fetch(`http://localhost:${a}:${b}@evil.example/`)",
            "fetch(`http://127.0.0.1:${p}.evil.example/`)",
            "fetch(`http://127.0.0.1:${p}x/`)",
            "fetch(`http://LOCALHOST:${p}@evil.example/`)",
            "fetch(`http://user@127.0.0.1:${p}/`)",
            "fetch(`http://127.0.0.1:${p}\\u0040evil.example/`)",
          ]) {
            expect(violations("new/file.ts", src), src).toContain(DYN("new/file.ts"));
            expect(violations(M, src), `${M} ${src}`).toContain(DYN(M));
          }
          expect(violations("new/file.ts", "fetch(`http://127.0.0.1:${p}@api.helius.xyz/`)").length).toBeGreaterThan(0);
        });

        it("(b) does not exempt a port interpolation that contains a brace, a quote or a backtick (its first `}` is not its end)", () => {
          // `${`${a}`}` and `${ {}/1 }` close at an inner `}`, so a regex that stops at the first `}` sees `/` or a backtick after it
          for (const src of [
            "fetch(`http://127.0.0.1:${`${a}`}@${h}/`)",
            "fetch(`http://127.0.0.1:${ {}/1 }@${h}/`)",
            "fetch(`http://localhost:${`${a}`}@${h}/`)",
            "fetch(`http://localhost:${ {}/1 }@${h}/`)",
            "fetch(`http://127.0.0.1:${`${a}`}@api.helius.xyz/`)",
            "fetch(`ws://127.0.0.1:${ {} }@${h}`)",
            "fetch(`http://127.0.0.1:${'8'}@${h}/`)",
            'fetch(`http://127.0.0.1:${"8"}@${h}/`)',
            'fetch(`http://127.0.0.1:${"@x"}/`)', // an interpolation whose own text is userinfo
            "fetch(`http://127.0.0.1:${`8`}/x`)",
            "fetch(`http://127.0.0.1:${{ p: 1 }.p}/x`)",
          ]) {
            expect(violations("new/file.ts", src), src).toContain(DYN("new/file.ts"));
            expect(violations(M, src), `${M} ${src}`).toContain(DYN(M));
          }
          // an ordinary expression in the port stays exempt
          for (const src of ["fetch(`http://127.0.0.1:${server.address().port}/x`)", "fetch(`http://localhost:${opts.port ?? 3000}`)", "fetch(`ws://127.0.0.1:${port + 1}/ws`)", "fetch(`http://127.0.0.1:${(s.address() as AddressInfo).port}/x`)"]) {
            expect(violations("t.ts", src), src).toEqual([]);
          }
        });

        it("(b) still allows a loopback test server on an interpolated port", () => {
          for (const src of [
            "fetch(`http://127.0.0.1:${port}/x`)",
            "fetch(`http://127.0.0.1:${port}`)",
            "fetch(`http://localhost:${port}?q=1`)",
            "fetch(`http://localhost:${port}#frag`)",
            "fetch(`ws://localhost:${port}/ws`)",
            "fetch(`http://127.0.0.1:${port}/${path}`)",
            "fetch(`http://127.0.0.1:${port}/x?a=${b}`)",
            "fetch(`http://127.0.0.1:${server.address().port}/x`)",
            "const u = `http://127.0.0.1:${port}",
          ]) expect(violations("t.ts", src), src).toEqual([]);
        });

        it("(b) accepts only / ? # a closing backtick or the end after the port interpolation: every other character can continue into userinfo", () => {
          // inside a template literal a quote, ) < > or a space is part of the string, and a URL parser strips CR, LF and TAB: all of
          // `http://127.0.0.1:8899<c>@evil.example/` have host evil.example
          for (const c of ["\n", "\r", "\t", "\r\n", "\n\t", " ", '"', "'", ")", "<", ">", ",", ";", "]", "\\"]) {
            for (const tail of ["@${h}/", "@evil.example/", "@api.helius.xyz/"]) {
              const src = `fetch(\`http://127.0.0.1:\${p}${c}${tail}\`)`;
              expect(violations("new/file.ts", src), JSON.stringify(src)).toContain(DYN("new/file.ts"));
              expect(violations(M, src), `${M} ${JSON.stringify(src)}`).toContain(DYN(M));
              const lh = src.replace("127.0.0.1", "localhost");
              expect(violations("new/file.ts", lh), JSON.stringify(lh)).toContain(DYN("new/file.ts"));
            }
          }
          expect(violations("new/file.ts", "fetch(`ws://localhost:${p}\n@${h}`)")).toContain(DYN("new/file.ts"));
          // a quote- or space-terminated form is no longer exempt either (conservative: write the closing backtick or a path)
          for (const src of ["const u = 'http://127.0.0.1:${port}';", 'const u = "http://localhost:${port}";', "log(`up at http://127.0.0.1:${port} now`)"]) {
            expect(violations("new/file.ts", src), src).toContain(DYN("new/file.ts"));
          }
        });

        it("(a) is not fooled by identity escapes, nested templates, bracket-call concat or long \\u{...} / entity digits", () => {
          for (const src of [
            "fetch('//api.hel\\ius.xyz/')",
            "fetch('//api\\.hel\\ius\\.xyz/')",
            "fetch(`//api.heli${`us`}.xyz/`)",
            'fetch(`//api.${"he" + "lius"}.xyz/`)',
            "fetch(`//api.${`he${'li'}us`}.xyz/`)",
            "fetch('//api.'.concat('heli').concat('us.xyz/'))",
            "fetch('//api.'?.concat('heli')?.concat('us.xyz/'))",
            "fetch('//api.'['concat']('heli')['concat']('us.xyz/'))",
            "fetch('//api.'?.['concat']('heli').concat('us.xyz/'))",
            "fetch('//api.helius'['concat']('.xyz/'))",
            'fetch("//api.helius"[ "concat" ](".xyz/"))',
            'fetch("//api.\\u{0000068}elius.xyz/")',
            'fetch("//api.\\u{00000000068}elius.xyz/")',
            '<a href="//api.&#x0000068;elius.xyz/">',
            '<a href="//api.&#0000104;elius.xyz/">',
          ]) expect(bare(violations("other.ts", src)), src).toBe(true);
        });

        it("(a) allows a sentence-ending period after the pinned host in prose, but not a trailing dot in a host or a literal", () => {
          for (const src of [
            "// Calls mainnet.helius-rpc.com. Read-only.",
            "/** POST to https://mainnet.helius-rpc.com/. */",
            "// see mainnet.helius-rpc.com.\nconst x = 1;",
            "// pinned: mainnet.helius-rpc.com.",
            "// the host mainnet.helius-rpc.com, read-only; and (mainnet.helius-rpc.com).",
          ]) expect(violations(M, src), src).toEqual([]);
          for (const src of [
            'const h = "mainnet.helius-rpc.com.";',
            "const h = 'mainnet.helius-rpc.com.';",
            "const h = `mainnet.helius-rpc.com.`;",
            'fetch("https://mainnet.helius-rpc.com./")',
            'fetch("//mainnet.helius-rpc.com. ")',
            'fetch("${s}://mainnet.helius-rpc.com. x")',
            'fetch("https://u@mainnet.helius-rpc.com. x")',
            'const h = "mainnet.helius-rpc.com.."; // x',
            "// mainnet.helius-rpc.com.. x",
            'const h = "mainnet.helius-rpc.com. ";',
              "// mainnet.helius-rpc.com.:8899 x",
            "// mainnet.helius-rpc.com.${path} x",
            "// mainnet.helius-rpc.com./v0/send x",
          ]) expect(violations(M, src).length, src).toBeGreaterThan(0);
          // the sentence period never lets the pinned host out of its module
          expect(bare(violations("other.ts", "// Calls mainnet.helius-rpc.com. Read-only."))).toBe(true);
          // and prose about the apex name keeps its period only in a frozen file
          const [f] = [...BARE_APEX_FILES];
          expect(violations(f!, "/** launched on pump.fun. Mint. */")).toEqual([]);
          expect(violations("other.ts", "/** launched on pump.fun. Mint. */").length).toBeGreaterThan(0);
        });

        it("(a) states the real sentence-period rule: one period before whitespace or the end, not directly after / @ or a quote", () => {
          // accepted (documented, not a bypass: the period is followed by a space and cannot end a host that is then used)
          expect(violations(M, 'const note = " mainnet.helius-rpc.com. ";')).toEqual([]);
          expect(violations(M, "const note = `see mainnet.helius-rpc.com.\nnext`;")).toEqual([]);
          // flagged: directly after a quote, `/`, `@` or a scheme, or with anything but whitespace after the period
          for (const src of ['"mainnet.helius-rpc.com. "', "'mainnet.helius-rpc.com.'", "//mainnet.helius-rpc.com. ", "u@mainnet.helius-rpc.com. "]) {
            expect(violations(M, src).length, src).toBeGreaterThan(0);
          }
        });

        it("(a) treats a backslash like a slash where a path or 'nothing attached' is judged (a URL parser does for http and https)", () => {
          const [f] = [...BARE_APEX_FILES];
          for (const src of ['const u = "https:\\\\pump.fun\\api\\trade";', 'fetch("//pump.fun\\coin\\x")', 'const u = "https:\\\\pumpportal.fun\\api\\trade";']) {
            expect(violations(f!, src).length, `${f} ${src}`).toBeGreaterThan(0);
            expect(violations("other.ts", src).length, `other.ts ${src}`).toBeGreaterThan(0);
          }
          for (const src of ['fetch("https://mainnet.helius-rpc.com\\v0\\x")', 'fetch("https:\\\\mainnet.helius-rpc.com\\")', 'const u = "https://mainnet.helius-rpc.com\\send";']) {
            expect(violations(M, src).length, `${M} ${src}`).toBeGreaterThan(0);
          }
          // a JS newline/tab escape right after the name is an escape, not a path: prose stays clean (the escape-free view reads "pump.funMint")
          expect(violations(f!, 'const s = "launched on pump.fun\\nMint";')).toEqual([]);
        });

        it("(a) is not fooled by a \\n, \\r or \\t escape before or inside a host (a URL parser drops LF, CR and TAB from a URL)", () => {
          const [f] = [...BARE_APEX_FILES];
          for (const src of [
            'fetch("https://\\npump.fun/api/trade")',
            'fetch("//\\npump.fun/api/trade")',
            'fetch("api.hel\\nius.xyz")',
            'fetch("https://\\rpump.fun/api/trade")',
            'fetch("https://\\tpump.fun/api/trade")',
            'fetch("//api.hel\\r\\nius.xyz/")',
            'fetch("//api.\\thelius.xyz/")',
            'fetch("//api.\\n\\n\\r\\thelius.xyz/")',
            'fetch("//api.hel" + "\\nius.xyz/")',
            'fetch(["//api.hel", "\\nius.xyz/"].join(""))',
            'fetch(["api", "hel\\nius", "xyz"].join("."))',
            "fetch(`${scheme}://\\npump.fun/api/trade`)",
            'fetch("https://pump.fun/coin/\\n../api/trade")',
            'fetch("wss://pumpportal.fun/api/data/\\t../trade")',
          ]) {
            expect(hit(violations("other.ts", src)), `other.ts ${src}`).toBe(true);
            expect(hit(violations(M, src)), `${M} ${src}`).toBe(true);
          }
          // in a frozen file, the bare apex name followed by an escape and then a path is the path
          expect(bare(violations(f!, 'const s = "pump.fun\\n/api/trade";'))).toBe(true);
          expect(bare(violations(f!, 'const s = "//pump.fun\\n/api/trade";'))).toBe(true);
          // in the module, the pinned host may not pick up a path after an escape either
          for (const src of ['fetch("https://mainnet.helius-rpc.com/\\nv0/send")', 'fetch("https://mainnet.helius-rpc.com\\n/v0/send")', 'fetch("https://mainnet.helius-rpc.com\\t:8899/")']) {
            expect(violations(M, src).length, `${M} ${src}`).toBeGreaterThan(0);
          }
          // no new false positives: an escape between words, and the allowed uses with an escape around them
          expect(violations(f!, 'const s = "launched on pump.fun\\nMint"; const t = "x\\npump.fun\\ny"; const u = "pump.fun\\n";')).toEqual([]);
          expect(violations("ok.ts", 'const a = "Visit\\npump.fun/coin/x"; const b = "wss://pumpportal.fun/api/data\\n"; const c = "notsolana\\n.com";')).toEqual([]);
          expect(violations(M, 'const a = "https://mainnet.helius-rpc.com/\\n"; // reads mainnet.helius-rpc.com\\n')).toEqual([]);
        });

        it("guidance for helius.ts and its test: written the recommended way both are clean, the tempting ways are flagged", () => {
          const HM = READ_ONLY_RPC_MODULE;
          const HT = "packages/core/src/study/helius.test.ts";
          // the module: a pinned-endpoint constant (NOT named like an RPC url/host/endpoint setting), a method-name constant, typed wrappers
          const moduleSrc = [
            'export const PINNED_ENDPOINT = "https://mainnet.helius-rpc.com/";',
            'export const TX_VERB = "getTransaction";',
            "export async function getTx(doFetch: typeof fetch, key: string, signature: string) {",
            "  // Reads one transaction from mainnet.helius-rpc.com. Read-only.",
            "  const res = await doFetch(`${PINNED_ENDPOINT}?api-key=${key}`, {",
            '    method: "POST",',
            '    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getTransaction", params: [signature] }),',
            "  });",
            "  return res.json();",
            "}",
          ].join("\n");
          // the test: imports the endpoint and the verb, never spells the host, the method names or the JSON-RPC envelope
          const testSrc = [
            'import { describe, expect, it } from "vitest";',
            'import { PINNED_ENDPOINT, TX_VERB, getTx } from "./helius.ts";',
            'describe("getTx", () => {',
            '  it("posts the read to the pinned endpoint", async () => {',
            "    const calls: { url: string; body: string }[] = [];",
            "    const fake = async (url: string, init: { body: string }) => {",
            "      calls.push({ url, body: init.body });",
            "      return { json: async () => ({ result: null }) };",
            "    };",
            '    await getTx(fake as never, "k", "sig");',
            "    expect(calls[0]!.url.startsWith(PINNED_ENDPOINT)).toBe(true);",
            "    expect((JSON.parse(calls[0]!.body) as { method: string }).method).toBe(TX_VERB);",
            "  });",
            "});",
          ].join("\n");
          expect(violations(HM, moduleSrc)).toEqual([]);
          expect(violations(HT, testSrc)).toEqual([]);
          // tempting, wrong: each is flagged
          const flagged = (file: string, src: string) => violations(file, src).length > 0;
          // a name that looks like an RPC endpoint setting, in the module and in the test that imports it
          expect(flagged(HM, moduleSrc.replaceAll("PINNED_ENDPOINT", "HELIUS_RPC_URL"))).toBe(true);
          expect(flagged(HM, moduleSrc.replaceAll("PINNED_ENDPOINT", "RPC_URL"))).toBe(true);
          expect(flagged(HM, moduleSrc.replaceAll("PINNED_ENDPOINT", "RPC_HOST"))).toBe(true);
          expect(flagged(HT, testSrc.replaceAll("PINNED_ENDPOINT", "HELIUS_RPC_URL"))).toBe(true);
          expect(flagged(HT, testSrc.replaceAll("PINNED_ENDPOINT", "RPC_ENDPOINT"))).toBe(true);
          // RPC_ENDPOINT_SETTING is case-insensitive and matches any prefix or suffix, so camelCase and decorated names are flagged too;
          // a name with no `rpc` in it is fine
          for (const name of ["rpcUrl", "rpcEndpoint", "rpcHost", "heliusRpcUrl", "MY_RPC_URL_2", "rpc_endpoint", "HELIUS_ENDPOINT"]) {
            expect(flagged(HM, moduleSrc.replaceAll("PINNED_ENDPOINT", name)), `${HM} ${name}`).toBe(true);
            expect(flagged(HT, testSrc.replaceAll("PINNED_ENDPOINT", name)), `${HT} ${name}`).toBe(true);
          }
          for (const name of ["PINNED_URL", "READ_ENDPOINT", "pinnedEndpoint", "ENDPOINT"]) {
            expect(violations(HM, moduleSrc.replaceAll("PINNED_ENDPOINT", name)), `${HM} ${name}`).toEqual([]);
            expect(violations(HT, testSrc.replaceAll("PINNED_ENDPOINT", name)), `${HT} ${name}`).toEqual([]);
          }
          // inside the module `method: TX_VERB` is "not a literal", even with TX_VERB exported next to it: write the literal in the request
          expect(violations(HM, moduleSrc.replace('method: "getTransaction"', "method: TX_VERB"))).toEqual([`${HM}: JSON-RPC method that is not a literal`]);
          // spelling the host in the test, in code or in a comment
          expect(flagged(HT, `${testSrc}\nconst U = "https://mainnet.helius-rpc.com/";`)).toBe(true);
          expect(flagged(HT, `${testSrc}\n// posts to mainnet.helius-rpc.com`)).toBe(true);
          expect(flagged(HT, `${testSrc}\n// not api.helius.xyz or an RPC provider like x.rpcpool.com`)).toBe(true);
          // rebuilding the URL from a host constant
          expect(flagged(HT, `${testSrc}\nconst U = \`https://\${HOST}/\`;`)).toBe(true);
          // the JSON-RPC envelope or a method name spelled in the test: only the module itself may
          expect(flagged(HT, `${testSrc}\nconst b = { jsonrpc: "2.0" };`)).toBe(true);
          expect(flagged(HT, `${testSrc}\nexpect(m).toBe("getTransaction");`)).toBe(true);
          // and the module still may not use the verbs it exports in a generic way
          expect(flagged(HM, `${moduleSrc}\nexport const rpc = (method: string) => method;`)).toBe(true);
        });

        // Catches cubic or worse, not quadratic: a quadratic scan stays under about 100 ms at these sizes (five are known, see the header).
        it("no scan goes cubic or worse: long runs of every character the normalisers and scanners quantify over stay fast, in any file and in the module", () => {
          const run = (unit: string) => (n: number) => unit.repeat(Math.ceil(n / unit.length));
          const after = (head: string, tail: string) => (n: number) => head + tail.repeat(n);
          const CASES: [string, (n: number) => string][] = [
            ["spaces", run(" ")], ["tabs", run("\t")], ["newlines", run("\n")], ["CRLF", run("\r\n")],
            ["double quotes", run('"')], ["single quotes", run("'")], ["backticks", run("`")], ["mixed quotes", run(`"'\``)],
            ["block comment openers", run("/*")], ["unclosed comments with text", run("/* x ")], ["comment closers", run("*/")],
            ["unclosed comments, one closer", (n) => `${"/* ".repeat(n / 3)}*/ const a = "b" + "c";`],
            ["backslashes", run("\\")], ["interpolation openers", run("${")], ["quoted interpolations", run('${"')],
            ["concat calls", run(".concat(")], ["quoted concat calls", run('".concat("')], ["bracket concat calls", run(`"?.["concat"]("`)],
            ["dots", run(".")], ["dotted labels", run("a.")], ["percent-encoded dots", run("%2e")], ["word characters", run("a")], ["hyphens", run("-")],
            ["a quote then spaces", after('"', " ")], ["a quote then newlines", after("'", "\n")], ["a quote then tabs", after("`", "\t")],
            ["a quote, spaces, a paren, spaces", (n) => `"${" ".repeat(n / 2)})${" ".repeat(n / 2)}`],
            ["a quote, spaces, a dot, spaces", (n) => `"${" ".repeat(n / 2)}.${" ".repeat(n / 2)}`],
            ["a quote, spaces, concat, spaces", (n) => `"${" ".repeat(n / 2)}.concat${" ".repeat(n / 2)}`],
            ["quote plus quote", run(`"+"`)], ["quote comma quote", run(`","`)], ["quote, spaces, plus", run('" +')],
            ["import then spaces", after("import", " ")], ["from then spaces", after("from", " ")], ["require then spaces", after("require(", " ")],
            ["destructured imports without a closing brace", run("const{sign ")], ["named imports", run("import {sign} from 'x';")],
            ["computed key openers", run('["')], ["array join openers", run('"//", ')],
            ["http schemes", run("http://")], ["loopback port interpolations", run("http://localhost:${")], ["scheme-less separators", run('"//')], ["a scheme then word characters", after("https://", "a")],
            ["method keys", run("method")], ["method then spaces", after("method", " ")], ["method literals", run('method: "')],
            ["unicode escape zeros", after("\\u{", "0")], ["hex entity zeros", after("&#x", "0")], ["decimal entity zeros", after("&#", "0")],
            ["hex digits", run("\\x4")], ["percent signs", run("%")], ["ideographic stops", run("。")],
            ["banned hosts", run("api.helius.xyz ")], ["banned hosts with paths", run("pump.fun/")], ["bare apex names", run("pump.fun. ")],
            ["pinned hosts", run("mainnet.helius-rpc.com. ")], ["ports", run(":8899")], ["host and port", run("localhost:8899 ")],
            ["setting names", run("RPC_")], ["helius names", run("HELIUS_")], ["signing calls", run("crypto.sign ")], ["signing then spaces", after("crypto.sign", " ")],
            ["everything at once", run(`"'\`/*\${.concat(%2e. \n\\`)],
          ];
          const slow: string[] = [];
          for (const file of ["big.ts", M]) {
            for (const [name, make] of CASES) {
              // a cubic scan needs about an hour on 20k characters, so a small probe goes first; a pass needs both sizes to be fast
              for (const [n, limit] of [[2_000, 300], [20_000, 3_000]] as const) {
                const t0 = performance.now();
                violations(file, make(n));
                const ms = performance.now() - t0;
                if (ms > limit) {
                  slow.push(`${file}: ${name} x${n}: ${Math.round(ms)} ms (limit ${limit})`);
                  break;
                }
              }
            }
          }
          expect(slow).toEqual([]);
        }, 300_000);

        it("keeps every earlier ban, allowance and frozen-list rule", () => {
          expect(violations("ok.ts", 'const STREAM_URL = "wss://pumpportal.fun/api/data"; const l = `https://pump.fun/coin/${mint}`; const a = "https://api.dexscreener.com";')).toEqual([]);
          expect(violations(M, `fetch("https://${READ_ONLY_RPC_HOST}/?api-key=x")`)).toEqual([]);
          // a URL with a banned host is reported once, not once per scan
          expect(violations("e.ts", 'fetch("https://api.helius.xyz/v0")')).toHaveLength(1);
          const endpoints = (src: string) => violations("e.ts", src).filter((v) => v.includes(": endpoint ") || v.includes(BARE));
          expect(endpoints('fetch("https://api.helius." + "xyz/v0")')).toHaveLength(1);
          expect(endpoints('fetch("//api.helius." + "xyz/v0")')).toHaveLength(1);
        });
      });

      it("fires for a JSON-RPC request outside the module, and for an RPC endpoint read from config or env", () => {
        for (const src of ['body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: m, params })', '{"jsonRPC":"2.0"}', "const j = 'JSONRPC';"]) {
          expect(violations("other.ts", src), src).toEqual(["other.ts: JSON-RPC request outside packages/core/src/study/helius.ts"]);
        }
        expect(violations(M, 'JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getTransaction", params })')).toEqual([]);
        for (const src of ["fetch(process.env.RPC_URL)", "const u = process.env.HELIUS_RPC_URL;", "const { rpcUrl } = cfg;", "const e = env.SOLANA_RPC_ENDPOINT;", "process.env.HELIUS_URL", "const h = cfg.rpcHost;"]) {
          expect(violations("other.ts", src), src).toHaveLength(1);
          expect(violations(M, `${reader}\n${src}`), `${M} ${src}`).toHaveLength(1);
        }
        expect(violations(M, `${reader}\nconst k = process.env.HELIUS_API_KEY;`)).toEqual([]);
      });

      it("fires inside the module for a method that is not a literal, so no generic rpc(method) can be exported", () => {
        const S = `${M}: JSON-RPC method that is not a literal`;
        for (const src of [
          "export async function rpc(method: string, params: unknown[]) { return call(method, params); }",
          "export const rpc = async (method: string) => fetch(u, { body: JSON.stringify({ jsonrpc: '2.0', method, params: [] }) });",
          'const body = { jsonrpc: "2.0", method: verb, params };',
          'const body = { jsonrpc: "2.0", method: `get${name}`, params };',
          'const body = { "method": m };',
          "const body = { jsonrpc: '2.0', method: cfg.method };",
          'const body = { jsonrpc: "2.0", method: "getBalance" };',
          'const body = { jsonrpc: "2.0", method: "send" + "Transaction" };',
        ]) expect(violations(M, src), src).toContain(S);
        for (const src of [
          'export const getTx = (sig: string) => post({ jsonrpc: "2.0", id: 1, method: "getTransaction", params: [sig] });',
          "fetch(url, { method: 'POST', body })",
          '{ "method": "getMultipleAccounts" }',
        ]) expect(violations(M, src), src).not.toContain(S);
        // outside the module the word is unremarkable
        expect(violations("other.ts", "fetch(u, { method })")).toEqual([]);
      });

      it("fires inside the module for the obvious ways to assemble a method name or host at run time", () => {
        for (const [src, what] of [
          ['const m = "send" + "Transaction";', "concatenated string literals"],
          ["const m = `send` + `Transaction`;", "concatenated string literals"],
          ["const m = String.fromCharCode(115, 101);", "string assembly"],
          ["const m = atob('c2VuZFRyYW5zYWN0aW9u');", "string assembly"],
          ["eval(code);", "eval or Function constructor"],
          ["new Function('return 1')();", "eval or Function constructor"],
          ["const p = new Proxy({}, h); Reflect.get(p, 'x');", "string assembly"],
          ['const o = { ["met" + "hod"]: x, ["a"]: 1 };', "computed literal property key"],
          ["const m = await import(name);", "dynamic import"],
        ] as const) expect(violations(M, src).some((v) => v.includes(what)), src).toBe(true);
        // not applied elsewhere
        expect(violations("other.ts", 'const m = "a" + "b"; const x = await import(name);')).toEqual([]);
      });

      it("fires for signing primitives anywhere, the module included", () => {
        for (const src of [
          'import { generateKeyPairSync } from "node:crypto"; generateKeyPairSync("rsa");',
          "const k = createPrivateKey(pem);",
          "const s = createSign('SHA256');",
          "crypto.sign(null, data, key);",
          "await crypto.subtle.importKey('raw', k, 'Ed25519', false, ['sign']);",
          'generateKeyPairSync("ed25519")',
          "const { webcrypto } = require('node:crypto');",
        ]) {
          expect(violations("other.ts", src).some((v) => v.includes("signing primitive")), src).toBe(true);
          expect(violations(M, `${reader}\n${src}`).some((v) => v.includes("signing primitive")), `${M} ${src}`).toBe(true);
        }
        for (const src of [
          'import { sign } from "node:crypto";',
          "import { sign as s, createHash } from 'crypto';",
          'import { createHash, sign } from "node:crypto";',
          'const { sign } = require("node:crypto");',
          "const { subtle } = globalThis.crypto;",
          "const { sign } = crypto;",
          'import { generateKeyPair } from "node:crypto";',
        ]) {
          expect(violations("other.ts", src).some((v) => v.includes("signing primitive")), src).toBe(true);
          expect(violations(M, `${reader}\n${src}`).some((v) => v.includes("signing primitive")), `${M} ${src}`).toBe(true);
        }
        expect(violations("ok.ts", 'import { createHash, randomBytes } from "node:crypto"; const { sign: signature } = body; const o = { sign };')).toEqual([]);
        expect(violations("ok.ts", "const h = createHash('sha256').update(x).digest('hex'); const b = randomBytes(8);")).toEqual([]);
      });

      it("does not loosen the other read-only Sources' rules", () => {
        expect(violations(M, 'const s = "wss://pumpportal.fun/api/data"; const l = `https://pump.fun/coin/${m}`;')).toEqual([]);
        expect(violations(M, 'fetch("https://pump.fun/api/ipfs")')).toHaveLength(1);
      });
    });

    it("flags chain RPC methods and key handling", () => {
      expect(violations("r.ts", 'rpc("sendTransaction", [tx])')).toHaveLength(1);
      expect(violations("r.ts", "method: 'getBalance'")).toHaveLength(1);
      expect(violations("k.ts", "const kp = Keypair.generate();")).toHaveLength(1);
      expect(violations("k.ts", "const k = process.env.PRIVATE_KEY")).toHaveLength(1);
    });
  });
});
