import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
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
  "getLatestBlockhash", "getBalance", "getAccountInfo", "getTokenAccountsByOwner", "getSignaturesForAddress", "getTransaction",
];

const KEY_WORDS = /\b(Keypair|secretKey|privateKey|PRIVATE_KEY|mnemonic)\b/;

const URL_RE = /\b(?:https?|wss?):\/\/[^\s"'`)<>\\]+/gi;

export function violations(file: string, text: string): string[] {
  const out: string[] = [];
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
    if (!BANNED_HOSTS.some((r) => r.test(u.hostname) || r.test(u.host))) continue;
    const ok = (u.hostname === "pumpportal.fun" && (u.pathname === "/api/data" || u.pathname.startsWith("/api/data/"))) || (u.hostname === "pump.fun" && u.pathname.startsWith("/coin/"));
    if (!ok) out.push(`${file}: endpoint ${u.href}`);
  }
  for (const method of RPC_METHODS) {
    if (new RegExp(`["'\`]${method}["'\`]`).test(text)) out.push(`${file}: RPC method "${method}"`);
  }
  const key = KEY_WORDS.exec(text);
  if (key) out.push(`${file}: key handling ${key[0]}`);
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

    it("flags chain RPC methods and key handling", () => {
      expect(violations("r.ts", 'rpc("sendTransaction", [tx])')).toHaveLength(1);
      expect(violations("r.ts", "method: 'getBalance'")).toHaveLength(1);
      expect(violations("k.ts", "const kp = Keypair.generate();")).toHaveLength(1);
      expect(violations("k.ts", "const k = process.env.PRIVATE_KEY")).toHaveLength(1);
    });
  });
});
