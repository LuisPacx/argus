import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { tempDir } from "../packages/core/src/testing/temp.ts";
// @ts-expect-error plain .mjs script, no types
import { cookieState } from "./doctor-cookies.mjs";
// @ts-expect-error plain .mjs script, no types
import { exitCodeOf, formatLine, runChecks } from "./doctor-checks.mjs";

interface Check {
  status: string;
  name: string;
  detail: string;
  fix?: string;
}

const good = {
  env: {} as Record<string, string>,
  home: "/h",
  root: "/r",
  run: () => ({ ok: true, stdout: JSON.stringify({ loggedIn: true, email: "secret@example.com" }) }),
  exists: () => true,
  isExecutable: () => true,
  cookieState: () => true,
  pidAlive: () => true,
  answers: async () => true,
};
const run = (over: Partial<typeof good>): Promise<Check[]> => runChecks({ ...good, ...over });
const byName = (cs: Check[], name: string) => cs.find((c) => c.name === name)!;

describe("doctor checks", () => {
  it("all good: every line PASS, exit 0, no value printed", async () => {
    const cs = await run({});
    expect(cs.map((c) => c.status)).toEqual(Array(cs.length).fill("PASS"));
    expect(exitCodeOf(cs)).toBe(0);
    expect(cs.map(formatLine).join("\n")).not.toContain("secret@example.com");
  });

  it("Claude: missing binary FAILs, logged out FAILs, unreadable status WARNs, ARGUS_CLAUDE_BIN is used", async () => {
    expect(byName(await run({ run: () => ({ ok: false, stdout: "", notFound: true }) }), "Claude CLI").status).toBe("FAIL");
    const out = byName(await run({ run: () => ({ ok: true, stdout: '{"loggedIn":false}' }) }), "Claude CLI");
    expect(out.status).toBe("FAIL");
    expect(out.fix).toContain("claude auth login");
    expect(byName(await run({ run: () => ({ ok: false, stdout: "" }) }), "Claude CLI").status).toBe("WARN");
    const seen: string[] = [];
    await run({ env: { ARGUS_CLAUDE_BIN: "/opt/claude" }, run: (bin: string, args: string[]) => (seen.push(bin, ...args), { ok: true, stdout: '{"loggedIn":true}' }) });
    expect(seen).toEqual(["/opt/claude", "auth", "status", "--json"]);
  });

  it("Chrome: missing profile and binary FAIL with the configured paths; ARGUS_CHROME_* are honoured", async () => {
    const cs = await run({ env: { ARGUS_CHROME_DIR: "/c/dir", ARGUS_CHROME_BIN: "/c/bin" }, exists: (p: string) => p !== "/c/dir", isExecutable: () => false });
    expect(byName(cs, "Argus Chrome profile")).toMatchObject({ status: "FAIL", detail: expect.stringContaining("/c/dir") });
    expect(byName(cs, "Chrome binary")).toMatchObject({ status: "FAIL", detail: expect.stringContaining("/c/bin") });
    expect(exitCodeOf(cs)).toBe(1);
    expect(byName(await run({}), "Argus Chrome profile").detail).toContain("/h/.local/share/argus/chrome");
  });

  it("X login: cookie present PASS, absent FAIL, unknown WARN", async () => {
    expect(byName(await run({ cookieState: () => false }), "X login").status).toBe("FAIL");
    expect(byName(await run({ cookieState: () => null }), "X login").status).toBe("WARN");
  });

  it("not running War Room and worker WARN (not FAIL) with the start hint", async () => {
    const cs = await run({ answers: async () => false, pidAlive: () => false });
    for (const n of ["War Room", "Worker"]) expect(byName(cs, n)).toMatchObject({ status: "WARN", fix: "run pnpm dev:start" });
    expect(exitCodeOf(cs)).toBe(0);
  });

  it("database: missing file WARNs, missing folder FAILs", async () => {
    expect(byName(await run({ exists: (p: string) => !p.endsWith("argus.db") }), "Database").status).toBe("WARN");
    expect(byName(await run({ exists: (p: string) => !p.includes("/.data") }), "Database").status).toBe("FAIL");
  });

  it("ARGUS_RESEARCH_TICK=1 WARNs about the old loop; 0 and unset PASS", async () => {
    const on = byName(await run({ env: { ARGUS_RESEARCH_TICK: "1" } }), "ARGUS_RESEARCH_TICK");
    expect(on.status).toBe("WARN");
    expect(on.detail).toContain("automatic");
    expect(byName(await run({ env: { ARGUS_RESEARCH_TICK: "0" } }), "ARGUS_RESEARCH_TICK").status).toBe("PASS");
  });
});

describe("cookieState", () => {
  function profile(rows: Array<[string, string]>): string {
    const dir = tempDir("doctor-");
    mkdirSync(join(dir, "Default"));
    const db = new DatabaseSync(join(dir, "Default", "Cookies"));
    db.exec("CREATE TABLE cookies (host_key TEXT, name TEXT, encrypted_value BLOB)");
    const ins = db.prepare("INSERT INTO cookies VALUES (?, ?, x'0102')");
    for (const [h, n] of rows) ins.run(h, n);
    db.close();
    return dir;
  }

  it("finds the X auth cookie, rejects other cookies, says unknown with no store", () => {
    expect(cookieState(profile([[".x.com", "auth_token"]]))).toBe(true);
    expect(cookieState(profile([[".x.com", "guest_id"], [".example.com", "auth_token"]]))).toBe(false);
    expect(cookieState(tempDir("doctor-empty-"))).toBeNull();
  });
});
