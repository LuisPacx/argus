import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// The researcher reaches no browser, no host and no environment of its own (human researcher ticket 05, ADR 0009). X goes through the scanner's child
// process (`MomentRunner`) and nothing else; coins go through the declared DexScreener client the worker hands in; the model gets only WebSearch and
// WebFetch. This greps the researcher's source, comments included, and fails on anything that could open a browser, make a request or read a variable.
const SRC = path.join(import.meta.dirname, "..");
const FILES = ["research/brief.ts", "research/researcher.ts", "research/x-read.ts", "research/dry-run.ts"];
const read = (f: string) => readFileSync(path.join(SRC, f), "utf8");

const FORBIDDEN = ["playwright", "chromium", "puppeteer", "selenium", ".launch(", "launchPersistentContext", "child_process", "spawn(", "spawnSync", "execFile", "execSync", "fetch(", "XMLHttpRequest", "WebSocket", "http.request", "https.request", "process.env", "process.argv", "spawnMomentRunner", "new DexScreenerClient", "timedFetchText", "readFileSync", "writeFileSync"];
/** The only host the researcher's code names: X's search page, built into the plan the scanner's child checks against its own allowlist. */
const DECLARED_HOSTS = new Set(["x.com"]);

describe("the researcher's code", () => {
  it.each(FILES)("%s opens no browser, makes no request and reads no variable", (f) => {
    const src = read(f);
    for (const token of FORBIDDEN) expect(src.includes(token), `${f} contains ${token}`).toBe(false);
  });

  it("names no host but the declared one", () => {
    const hosts = FILES.flatMap((f) => [...read(f).matchAll(/\b(?:https?|wss?):\/\/([A-Za-z0-9.-]+)/g)].map((m) => m[1]!.toLowerCase()));
    expect(hosts.length).toBeGreaterThan(0); // the scan found the one address
    for (const h of hosts) expect(DECLARED_HOSTS.has(h), h).toBe(true);
  });

  it("reaches X only through the scanner's runner type and its session gate", () => {
    const x = read("research/x-read.ts");
    expect(x).toContain('import type { MomentRunner } from "../moments/scan-runner.ts"');
    expect(x).toContain("runXJob(store.xSession");
    expect(x.match(/await runner\(/g)).toHaveLength(1);
  });

  it("the model's task has two tools, both web reading, and no shell, file or browser tool", async () => {
    const { DEFAULT_ROUTING } = await import("../brain.ts");
    expect([...DEFAULT_ROUTING.researcher.tools]).toEqual(["WebSearch", "WebFetch"]);
    expect(DEFAULT_ROUTING.researcher.allowedTools).toBeUndefined();
    expect(DEFAULT_ROUTING.researcher.backend).toBe("claude-code");
  });

  it("the worker wires the real scanner child and the declared DexScreener client, nothing else", () => {
    const main = readFileSync(path.join(SRC, "../../../apps/worker/src/main.ts"), "utf8");
    expect(main).toContain("const researchXRunner = spawnMomentRunner();");
    expect(main).toContain("const researchDex = new DexScreenerClient(");
    expect(main).toContain("dex: researchDex, xRunner: researchXRunner");
  });
});
