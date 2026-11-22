import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { tempDir } from "../packages/core/src/testing/temp.ts";
// @ts-expect-error plain .mjs script, no types
import { cookieState } from "./setup-check-cookies.mjs";
// @ts-expect-error plain .mjs script, no types
import { exitCodeOf, formatLine, mainCheckoutRoot, runChecks } from "./setup-check-checks.mjs";
import { automaticAgents } from "../packages/core/src/automatic-agents.ts";

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

describe("setup-check checks", () => {
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

  it("every automatic switch that is on WARNs with the Operator-rule message; off and unset PASS", async () => {
    const cs = await run({ env: { ARGUS_RESEARCH_TICK: "1", ARGUS_MEME_IDEAS: "1", ARGUS_MOMENTS: "1" } });
    expect(byName(cs, "ARGUS_MEME_IDEAS")).toMatchObject({
      status: "WARN",
      detail: "Meta meme ideas is ON: Claude runs by itself (Operator rule: only when you trigger it). Remove ARGUS_MEME_IDEAS from .env",
    });
    expect(byName(cs, "ARGUS_RESEARCH_TICK").status).toBe("WARN");
    expect(byName(cs, "ARGUS_MOMENTS").status).toBe("WARN");
    expect(exitCodeOf(cs)).toBe(0);
    for (const env of [{ ARGUS_RESEARCH_TICK: "0", ARGUS_MEME_IDEAS: "", ARGUS_MOMENTS: "0" }, {}]) {
      const off = await run({ env });
      for (const n of ["ARGUS_RESEARCH_TICK", "ARGUS_MEME_IDEAS", "ARGUS_MOMENTS"]) expect(byName(off, n).status).toBe("PASS");
    }
  });

  it("an invalid switch value FAILs with the worker's rule, without hiding the other switches", async () => {
    const cs = await run({ env: { ARGUS_RESEARCH_TICK: "yes", ARGUS_MEME_IDEAS: "1" } });
    expect(byName(cs, "ARGUS_RESEARCH_TICK")).toMatchObject({ status: "FAIL", fix: "use 1, 0 or leave empty" });
    expect(byName(cs, "ARGUS_MEME_IDEAS").status).toBe("WARN");
    expect(formatLine(byName(cs, "ARGUS_RESEARCH_TICK"))).not.toContain("yes");
    expect(exitCodeOf(cs)).toBe(1);
  });

  it("covers every switch in automatic-agents.ts, so a new one cannot be missed", async () => {
    const env = Object.fromEntries(automaticAgents({}).map((a) => [a.switch, "1"]));
    const cs = await run({ env });
    for (const a of automaticAgents({})) expect(byName(cs, a.switch)).toMatchObject({ status: "WARN", detail: expect.stringContaining(a.label) });
  });
});

describe("mainCheckoutRoot", () => {
  it("a git worktree reads the main checkout's root (its .data/run holds the live pid files); a plain checkout stays", () => {
    const wt = tempDir("setup-check-wt-");
    writeFileSync(join(wt, ".git"), "gitdir: /home/u/code/argus/.git/worktrees/agent-x\n");
    expect(mainCheckoutRoot(wt)).toBe("/home/u/code/argus");
    const plain = tempDir("setup-check-plain-");
    mkdirSync(join(plain, ".git"));
    expect(mainCheckoutRoot(plain)).toBe(plain);
    expect(mainCheckoutRoot(tempDir("setup-check-nogit-"))).toBeTruthy();
  });
});

describe("cookieState", () => {
  function profile(rows: Array<[string, string]>): string {
    const dir = tempDir("setup-check-");
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
    expect(cookieState(tempDir("setup-check-empty-"))).toBeNull();
  });

  it("creates no file beside Chrome's cookie store", () => {
    const dir = profile([[".x.com", "auth_token"]]);
    const before = readdirSync(join(dir, "Default")).sort();
    cookieState(dir);
    expect(readdirSync(join(dir, "Default")).sort()).toEqual(before);
    expect(readdirSync(dir).sort()).toEqual(["Default"]);
  });

  it("an unreadable cookie store is cannot-tell (null), not a throw", () => {
    const dir = tempDir("setup-check-bad-");
    mkdirSync(join(dir, "Default"));
    writeFileSync(join(dir, "Default", "Cookies"), "this is not a sqlite file at all, just text padding".repeat(20));
    expect(cookieState(dir)).toBeNull();
  });
});
