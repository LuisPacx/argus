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

// An RPC endpoint or a Helius setting read from the environment or config: the RPC host is pinned in the module, never configured.
const RPC_ENDPOINT_SETTING = /\b\w*RPC_?(?:URL|URI|ENDPOINT|HOST)\w*\b|\bHELIUS_(?!API_KEY\b)\w+/i;

const URL_RE = /\b(?:https?|wss?):\/\/[^\s"'`)<>\\]+/gi;

// A URL whose host is built at run time (`https://${h}/`, `"https://" + h`, `["https://", h].join("")`) is invisible to the host bans.
const DYNAMIC_HOST = /\b(?:https?|wss?):\/\/(?:\$\{|["'`])/i;
// Stricter, for the read-only module: no interpolation or concatenation anywhere in the host part.
const DYNAMIC_HOST_STRICT = /\b(?:https?|wss?):\/\/[^/?#\s"'`]*(?:\$\{|["'`]\s*\+)/i;
// Files that already build a URL host at run time (test servers on a loopback port, fake hosts, a link normaliser). Frozen: a new
// file that needs this is a change to this list, which the reviewer sees. Never the read-only module.
const DYNAMIC_HOST_FILES = new Set<string>([
  "packages/core/src/egress-proxy.test.ts",
  "packages/core/src/evidence-links.test.ts",
  "packages/core/src/sandbox.ts",
  "packages/core/src/signals.test.ts",
  "packages/core/src/source-polls.test.ts",
  "packages/core/src/sources/pumpportal-study.test.ts",
  "packages/core/src/study/guarded-fetch.test.ts",
  "packages/core/src/study/metadata.ts",
  "packages/core/src/testing/fake-wrangler.mjs",
  "scripts/verify-boot.mjs",
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
  for (const m of text.matchAll(/(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)["']([^"']+)["']/g)) {
    if (BANNED_PACKAGES.some((r) => r.test(m[1]!))) out.push(`${file}: import ${m[1]}`);
  }
  for (const m of text.matchAll(URL_RE)) {
    let u: URL;
    try {
      u = new URL(m[0].replace(/[.,;]+$/, ""));
    } catch {
      continue;
    }
    // `new URL` keeps a trailing dot (`host.com.`, also from `%2e` and the ideographic full stop), which is the same host to DNS.
    const host = stripTrailingDots(u.hostname);
    const hostPort = u.port === "" ? host : `${host}:${u.port}`;
    if (!BANNED_HOSTS.some((r) => r.test(host) || r.test(hostPort))) continue;
    const ok = (host === "pumpportal.fun" && (u.pathname === "/api/data" || u.pathname.startsWith("/api/data/"))) || (host === "pump.fun" && u.pathname.startsWith("/coin/"));
    // The pinned form only: the exact host (no trailing dot), https, no port or userinfo, path "/".
    const readOnly = readOnlyRpc && u.protocol === "https:" && u.hostname === READ_ONLY_RPC_HOST && u.port === "" && u.username === "" && u.password === "" && u.pathname === "/";
    if (!ok && !readOnly) out.push(`${file}: endpoint ${u.href}`);
  }
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
  const sign = SIGNING_PRIMITIVES.exec(text);
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
        // a loopback port or a path may be interpolated; a partial host may not (in the module)
        expect(violations("t.ts", "const u = `http://127.0.0.1:${port}/x`; const v = `https://x.com${path}`;")).toEqual([]);
        for (const src of ["fetch(`https://api.${d}/`)", 'fetch("https://api." + d)', "fetch(`https://mainnet.helius-rpc.com.${d}/`)", "fetch(`https://mainnet.helius-rpc.com${path}`)"]) {
          expect(violations(M, src), src).toContain(`${M}: URL with a host built at run time`);
        }
        expect(DYNAMIC_HOST_FILES.has(M)).toBe(false);
        expect(violations([...DYNAMIC_HOST_FILES][0]!, "fetch(`https://${HOST}/`)")).toEqual([]);
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
