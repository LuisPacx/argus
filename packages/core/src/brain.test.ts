import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { BrainError, ClaudeCodeBrain, DEFAULT_ROUTING, killLiveBrainChildren, resolveRouting, scrubEnv } from "./brain.ts";
import { FAKE_CLAUDE } from "./testing/fake-claude.ts";

function setup(mode: string, extra: Partial<ConstructorParameters<typeof ClaudeCodeBrain>[0]> = {}) {
  const log = join(mkdtempSync(join(tmpdir(), "argus-brain-")), "calls.jsonl");
  const brain = new ClaudeCodeBrain({
    command: FAKE_CLAUDE,
    env: {
      PATH: process.env.PATH,
      HOME: "/home/x",
      ANTHROPIC_API_KEY: "sk-secret",
      AWS_SECRET: "nope",
      CLAUDE_CODE_OAUTH_TOKEN: "tok",
      FAKE_CLAUDE_MODE: mode,
      FAKE_CLAUDE_LOG: log,
      FAKE_CLAUDE_STARTED: join(dirname(log), "started"),
    },
    passEnv: ["FAKE_CLAUDE_MODE", "FAKE_CLAUDE_LOG", "FAKE_CLAUDE_STARTED"],
    ...extra,
  });
  const calls = () =>
    readFileSync(log, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as { argv: string[]; env: Record<string, string>; cwd: string; skills: string[]; pid: number });
  return { brain, calls, log, started: join(dirname(log), "started") };
}

describe("ClaudeCodeBrain", () => {
  for (const format of ["json", "stream-json"] as const) {
    it(`returns output, session and cost on success (${format})`, async () => {
      const { brain } = setup("success", { outputFormat: format });
      const run = await brain.run<string>("spec", { prompt: "p" });
      expect(run).toMatchObject({ output: expect.stringContaining("# Fake Spec"), sessionId: "fake-session-1", totalCostUsd: 0.0123, backend: "claude-code", model: "sonnet" });
    });
  }

  it("scrubs the child environment: no ANTHROPIC_API_KEY, only needed variables", async () => {
    const { brain, calls } = setup("success");
    await brain.run("spec", { prompt: "p" });
    const env = calls()[0]!.env;
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.AWS_SECRET).toBeUndefined();
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe("tok");
    expect(scrubEnv({ ANTHROPIC_API_KEY: "x" }, ["ANTHROPIC_API_KEY"])).toEqual({});
  });

  it("passes --max-budget-usd from config and never raises it", async () => {
    const routing = resolveRouting({ spec: { maxBudgetUsd: 1.5 } });
    const { brain, calls } = setup("success", { routing });
    await brain.run("spec", { prompt: "p" });
    await brain.run("spec", { prompt: "p" }, { maxBudgetUsd: 100 });
    await brain.run("spec", { prompt: "p" }, { maxBudgetUsd: 0.5 });
    const budgets = calls().map((c) => c.argv[c.argv.indexOf("--max-budget-usd") + 1]);
    expect(budgets).toEqual(["1.5", "1.5", "0.5"]);
  });

  it("invokes the task's skill and model from routing data", async () => {
    const { brain, calls } = setup("success", { routing: resolveRouting({ spec: { model: "opus" } }) });
    await brain.run("spec", { prompt: "hello" });
    const { argv } = calls()[0]!;
    expect(argv[1]).toBe("/spec\n\nhello");
    expect(argv[argv.indexOf("--model") + 1]).toBe("opus");
  });

  it("fails the run when the budget cap is hit, keeping the cost", async () => {
    const { brain } = setup("budget");
    const err = await brain.run("spec", { prompt: "p" }).catch((e) => e);
    expect(err).toBeInstanceOf(BrainError);
    expect(err).toMatchObject({ kind: "budget-exceeded", totalCostUsd: 2.01 });
  });

  it("classifies failure and rate limiting", async () => {
    expect(await setup("failure").brain.run("spec", { prompt: "p" }).catch((e) => e)).toMatchObject({ kind: "failed", totalCostUsd: 0.004 });
    expect(await setup("ratelimit", { outputFormat: "stream-json" }).brain.run("spec", { prompt: "p" }).catch((e) => e)).toMatchObject({ kind: "rate-limited" });
  });

  describe("rate-limit detection uses claude's real signals", () => {
    const kindOf = async (mode: string, outputFormat: "json" | "stream-json" = "json") =>
      ((await setup(mode, { outputFormat }).brain.run("spec", { prompt: "p" }).catch((e) => e)) as BrainError).kind;

    it("structured api_error_status 429 on the result", async () => {
      expect(await kindOf("ratelimit-structured")).toBe("rate-limited");
    });
    it("a rejected rate_limit_event in the stream (an allowed one does not count)", async () => {
      expect(await kindOf("ratelimit-event", "stream-json")).toBe("rate-limited");
      expect(await kindOf("failure", "stream-json")).toBe("failed");
    });
    it("the anchored usage-limit message, on a result or on stderr when there is no result", async () => {
      expect(await kindOf("ratelimit")).toBe("rate-limited");
      expect(await kindOf("noresult-ratelimit")).toBe("rate-limited");
    });
    it("prose that merely mentions 429 or rate limits is a plain failure", async () => {
      expect(await kindOf("failure-429text")).toBe("failed");
      expect(await kindOf("noresult")).toBe("failed");
    });
  });

  it("exiting without a result message fails the run", async () => {
    const err = (await setup("noresult").brain.run("spec", { prompt: "p" }).catch((e) => e)) as BrainError;
    expect(err).toBeInstanceOf(BrainError);
    expect(err.message).toContain("without a result");
    expect(err.totalCostUsd).toBe(0);
  });

  it("every default route sets a wall-clock cap and a tool list; spec gets no tools", () => {
    for (const route of Object.values(DEFAULT_ROUTING)) {
      expect(route.timeoutMs).toBeGreaterThan(0);
      expect(Array.isArray(route.tools)).toBe(true);
    }
    expect(DEFAULT_ROUTING.spec.tools).toEqual([]);
  });

  it("passes the tool restriction: --tools \"\" for none, --tools plus --allowedTools otherwise", async () => {
    const { brain, calls } = setup("success");
    await brain.run("spec", { prompt: "p" });
    await brain.run("propose", { prompt: "p" });
    const [spec, propose] = calls().map((c) => c.argv);
    expect(spec![spec!.indexOf("--tools") + 1]).toBe("");
    expect(spec).not.toContain("--allowedTools");
    expect(propose![propose!.indexOf("--tools") + 1]).toBe("WebSearch,WebFetch");
    expect(propose![propose!.indexOf("--allowedTools") + 1]).toBe("WebSearch,WebFetch");
  });

  describe("wall-clock timeout", () => {
    const alive = (pid: number) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    const fast = (timeoutMs = 300) => resolveRouting({ spec: { timeoutMs } });

    it("kills a hung child and fails the run as timed-out", async () => {
      const { brain, calls } = setup("hang", { routing: fast(), killGraceMs: 200 });
      const t0 = Date.now();
      const err = (await brain.run("spec", { prompt: "p" }).catch((e) => e)) as BrainError;
      expect(err).toBeInstanceOf(BrainError);
      expect(err.kind).toBe("timed-out");
      expect(Date.now() - t0).toBeLessThan(5_000);
      expect(alive(calls()[0]!.pid)).toBe(false);
    });

    it("escalates to SIGKILL when the child ignores SIGTERM", async () => {
      const { brain, calls } = setup("hang-stubborn", { routing: fast(), killGraceMs: 200 });
      const err = (await brain.run("spec", { prompt: "p" }).catch((e) => e)) as BrainError;
      expect(err.kind).toBe("timed-out");
      expect(alive(calls()[0]!.pid)).toBe(false);
    });

    it("killLiveBrainChildren stops a running child (worker shutdown)", async () => {
      const { brain, calls, started } = setup("hang-stubborn", { routing: fast(60_000), killGraceMs: 200 });
      const running = brain.run("spec", { prompt: "p" }).catch((e) => e);
      const deadline = Date.now() + 5_000;
      while (!existsSync(started) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
      await new Promise((r) => setTimeout(r, 100)); // the fake installs its SIGTERM handler before writing the marker
      const pid = calls()[0]!.pid;
      expect(await killLiveBrainChildren(200)).toBe(1);
      expect(alive(pid)).toBe(false);
      expect(await running).toMatchObject({ kind: "interrupted" });
    });

    it("aborting the signal kills the child and fails the run as interrupted, not failed", async () => {
      const { brain, calls, started } = setup("hang-stubborn", { routing: fast(60_000), killGraceMs: 200 });
      const ac = new AbortController();
      const running = brain.run("spec", { prompt: "p" }, { signal: ac.signal }).catch((e) => e);
      const deadline = Date.now() + 5_000;
      while (!existsSync(started) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
      await new Promise((r) => setTimeout(r, 100));
      ac.abort();
      expect(await running).toMatchObject({ kind: "interrupted", totalCostUsd: 0 });
      expect(alive(calls()[0]!.pid)).toBe(false);
    });

    it("an already-aborted signal spawns nothing", async () => {
      const { brain, log } = setup("success");
      const err = await brain.run("spec", { prompt: "p" }, { signal: AbortSignal.abort() }).catch((e) => e);
      expect(err).toMatchObject({ kind: "interrupted" });
      expect(existsSync(log)).toBe(false);
    });

    it("keeps the spend a killed child reports", async () => {
      const { brain, started } = setup("hang-report", { routing: fast(60_000), killGraceMs: 200 });
      const ac = new AbortController();
      const running = brain.run("spec", { prompt: "p" }, { signal: ac.signal }).catch((e) => e);
      const deadline = Date.now() + 5_000;
      while (!existsSync(started) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
      await new Promise((r) => setTimeout(r, 100));
      ac.abort();
      expect(await running).toMatchObject({ kind: "interrupted", totalCostUsd: 0.004, sessionId: "fake-session-1" });
    });
  });

  it("keeps user-level Claude config out of every route: strict MCP and project-only settings", async () => {
    const { brain, calls } = setup("success");
    for (const task of ["judge", "propose", "spec", "build"] as const) await brain.run(task, { prompt: "p" });
    for (const { argv } of calls()) {
      expect(argv).toContain("--strict-mcp-config");
      expect(argv).not.toContain("--mcp-config");
      expect(argv[argv.indexOf("--setting-sources") + 1]).toBe("project");
    }
  });

  it("does not leak the temp dir when preparing the skill directory throws", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "argus-tmpdir-"));
    const { brain } = setup("success", { skillsDir: join(tmp, "no-such-skills") });
    const saved = process.env.TMPDIR;
    process.env.TMPDIR = tmp;
    try {
      await expect(brain.run("spec", { prompt: "p" })).rejects.toThrow();
      expect(readdirSync(tmp).filter((n) => n.startsWith("argus-brain-"))).toEqual([]);
    } finally {
      if (saved === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = saved;
    }
  });

  describe("isolated working directory", () => {
    it("runs from a temp dir holding only the task's skill, never the repo root, and cleans it up", async () => {
      const repoRoot = join(import.meta.dirname, "../../..");
      const { brain, calls } = setup("success", { skillsDir: join(repoRoot, ".claude", "skills") });
      await brain.run("spec", { prompt: "p" });
      const call = calls()[0]!;
      expect(call.cwd).not.toBe(repoRoot);
      expect(call.cwd.startsWith(repoRoot)).toBe(false);
      expect(call.skills).toEqual(["spec"]);
      expect(existsSync(call.cwd)).toBe(false);
    });

    it("an explicit cwd wins over skillsDir", async () => {
      const dir = mkdtempSync(join(tmpdir(), "argus-cwd-"));
      mkdirSync(join(dir, "sub"));
      writeFileSync(join(dir, "sub", ".keep"), "");
      const { brain, calls } = setup("success", { cwd: join(dir, "sub"), skillsDir: "/nonexistent" });
      await brain.run("spec", { prompt: "p" });
      expect(calls()[0]!.cwd).toContain("sub");
    });
  });

  it("--dry-run logs the command and spawns nothing", async () => {
    const lines: string[] = [];
    const { brain, log } = setup("success", { dryRun: true, log: (l) => lines.push(l) });
    const run = await brain.run("spec", { prompt: "p" });
    expect(run.dryRun).toBe(true);
    expect(lines.join("\n")).toContain("--max-budget-usd 2");
    expect(() => readFileSync(log)).toThrow();
  });
});
