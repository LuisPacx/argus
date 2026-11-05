import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tempDir } from "./testing/temp.ts";
import { describe, expect, it, vi } from "vitest";
import { BrainError, ClaudeCodeBrain, DEFAULT_ROUTING, killLiveBrainChildren, resolveRouting, scrubEnv, sessionIdOf } from "./brain.ts";
import { FAKE_CLAUDE } from "./testing/fake-claude.ts";
import { untilExists } from "./testing/wait.ts";

function setup(mode: string, extra: Partial<ConstructorParameters<typeof ClaudeCodeBrain>[0]> = {}) {
  const log = join(tempDir("argus-brain-"), "calls.jsonl");
  const brain = new ClaudeCodeBrain({
    command: FAKE_CLAUDE,
    // The fake claude writes .fake-sessions into its cwd; never let that be the repo.
    ...(extra.skillsDir === undefined ? { cwd: tempDir("argus-brain-cwd-") } : {}),
    env: {
      PATH: process.env.PATH,
     
      HOME: "/home/x",
      ANTHROPIC_API_KEY: "sk-secret",
      AWS_SECRET: "nope",
      CLAUDE_CODE_OAUTH_TOKEN: "tok",
      FAKE_CLAUDE_MODE: mode,
      FAKE_CLAUDE_LOG: log,
      FAKE_CLAUDE_STARTED: join(dirname(log), "started"),
      FAKE_CLAUDE_TERMED: join(dirname(log), "termed"),
      FAKE_CLAUDE_GRANDCHILD: join(dirname(log), "grandchild"),
    },
    passEnv: ["FAKE_CLAUDE_MODE", "FAKE_CLAUDE_LOG", "FAKE_CLAUDE_STARTED", "FAKE_CLAUDE_TERMED", "FAKE_CLAUDE_GRANDCHILD"],
    ...extra,
  });
  const calls = () =>
    readFileSync(log, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as { argv: string[]; env: Record<string, string>; cwd: string; skills: string[]; pid: number });
  return { brain, calls, log, started: join(dirname(log), "started"), termed: join(dirname(log), "termed"), grandchild: join(dirname(log), "grandchild") };
}

describe("ClaudeCodeBrain", () => {
  for (const format of ["json", "stream-json"] as const) {
    it(`returns output, session and cost on success (${format})`, async () => {
      const { brain } = setup("success", { outputFormat: format });
      const run = await brain.run<string>("spec", { prompt: "p" });
      expect(run).toMatchObject({ output: expect.stringContaining("# Fake Spec"), sessionId: "5e55a0a0-0000-4000-8000-000000000001", totalCostUsd: 0.0123, backend: "claude-code", model: "sonnet" });
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
    // Real timers even while a test fakes the global ones.
    const realSetTimeout = globalThis.setTimeout;
    const untilDead = async (pid: number, deadlineMs = 20_000) => {
      const end = Date.now() + deadlineMs;
      while (alive(pid) && Date.now() < end) await new Promise((r) => realSetTimeout(r, 10));
      expect(alive(pid)).toBe(false);
    };
    const fast = (timeoutMs: number) => resolveRouting({ spec: { timeoutMs } });
    const CAP = 60_000;

    /**
     * The cap and the kill grace are timers in this process, so they are driven by hand: start the run, wait for the child
     * to say it is up (never a guessed delay: node start-up time varies with machine load), then advance the clock. Nothing
     * here depends on how long anything really takes.
     */
    const withFakeTimers = async (body: () => Promise<void>) => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      try {
        await body();
      } finally {
        vi.useRealTimers();
      }
    };

    it("kills a hung child and fails the run as timed-out", () =>
      withFakeTimers(async () => {
        const { brain, calls, started } = setup("hang", { routing: fast(CAP), killGraceMs: 200 });
        const running = brain.run("spec", { prompt: "p" }).catch((e) => e);
        await untilExists(started);
        const pid = calls()[0]!.pid;
        expect(alive(pid)).toBe(true);
        vi.advanceTimersByTime(CAP);
        const err = (await running) as BrainError;
        expect(err).toBeInstanceOf(BrainError);
        expect(err.kind).toBe("timed-out");
        expect(alive(pid)).toBe(false);
      }));

    it("escalates to SIGKILL when the child ignores SIGTERM", () =>
      withFakeTimers(async () => {
        const { brain, calls, started, termed } = setup("hang-stubborn", { routing: fast(CAP), killGraceMs: 200 });
        const running = brain.run("spec", { prompt: "p" }).catch((e) => e);
        await untilExists(started);
        const pid = calls()[0]!.pid;
        vi.advanceTimersByTime(CAP); // cap reached: SIGTERM
        await untilExists(termed); // the child got SIGTERM and ignored it
        expect(alive(pid)).toBe(true);
        vi.advanceTimersByTime(200); // grace over: SIGKILL
        const err = (await running) as BrainError;
        expect(err.kind).toBe("timed-out");
        expect(alive(pid)).toBe(false);
      }));

    it("the timeout kills the whole process group: a grandchild that ignores SIGTERM dies too", () =>
      withFakeTimers(async () => {
        const { brain, started, termed, grandchild } = setup("hang-stubborn", { routing: fast(CAP), killGraceMs: 100 });
        const running = brain.run("spec", { prompt: "p" }).catch((e) => e);
        await untilExists(started);
        const gc = Number(readFileSync(grandchild, "utf8"));
        expect(alive(gc)).toBe(true);
        vi.advanceTimersByTime(CAP); // SIGTERM: the leader and the grandchild both ignore it
        await untilExists(termed);
        vi.advanceTimersByTime(100); // grace over: SIGKILL to the group
        expect(await running).toMatchObject({ kind: "timed-out" });
        await untilDead(gc);
      }));

    it("a grandchild that outlives a leader dying on SIGTERM is SIGKILLed with the group, not left until the grace runs out", () =>
      withFakeTimers(async () => {
        // The grace timer is never advanced: only the group kill at `close` can end the grandchild.
        const { brain, started, grandchild } = setup("hang", { routing: fast(CAP), killGraceMs: 60_000 });
        const running = brain.run("spec", { prompt: "p" }).catch((e) => e);
        await untilExists(started);
        const gc = Number(readFileSync(grandchild, "utf8"));
        vi.advanceTimersByTime(CAP); // SIGTERM: the leader dies, the grandchild ignores it
        expect(await running).toMatchObject({ kind: "timed-out" });
        await untilDead(gc);
      }));

    it("a process the child leaves running after a normal exit is reaped with its group", async () => {
      const { brain, grandchild } = setup("success-straggler");
      await brain.run("spec", { prompt: "p" });
      await untilDead(Number(readFileSync(grandchild, "utf8")));
    });

    it("shutdown kills the whole process group, grandchildren included", async () => {
      const { brain, started, grandchild } = setup("hang-stubborn", { routing: fast(CAP), killGraceMs: 100 });
      const running = brain.run("spec", { prompt: "p" }).catch((e) => e);
      await untilExists(started);
      const gc = Number(readFileSync(grandchild, "utf8"));
      expect(await killLiveBrainChildren(100)).toBe(1);
      expect(await running).toMatchObject({ kind: "interrupted" });
      await untilDead(gc);
    });

    it("killLiveBrainChildren stops a running child (worker shutdown)", async () => {
      const { brain, calls, started } = setup("hang-stubborn", { routing: fast(CAP), killGraceMs: 200 });
      const running = brain.run("spec", { prompt: "p" }).catch((e) => e);
      await untilExists(started); // the fake installs its SIGTERM handler before writing the marker
      const pid = calls()[0]!.pid;
      expect(await killLiveBrainChildren(200)).toBe(1);
      expect(alive(pid)).toBe(false);
      expect(await running).toMatchObject({ kind: "interrupted" });
    });

    it("aborting the signal kills the child and fails the run as interrupted, not failed", async () => {
      const { brain, calls, started } = setup("hang-stubborn", { routing: fast(CAP), killGraceMs: 200 });
      const ac = new AbortController();
      const running = brain.run("spec", { prompt: "p" }, { signal: ac.signal }).catch((e) => e);
      await untilExists(started);
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

    it("a successful result printed just before the cap fires still succeeds", () =>
      withFakeTimers(async () => {
        const { brain, started } = setup("hang-success", { routing: fast(CAP), killGraceMs: 200 });
        const running = brain.run("spec", { prompt: "p" });
        await untilExists(started); // the result is already flushed; the child now hangs
        vi.advanceTimersByTime(CAP);
        expect(await running).toMatchObject({ output: expect.stringContaining("# Fake Spec"), sessionId: "5e55a0a0-0000-4000-8000-000000000001", totalCostUsd: 0.0123 });
      }));

    it("a successful result printed just before shutdown aborts still succeeds", async () => {
      const { brain, started } = setup("hang-success", { routing: fast(CAP), killGraceMs: 200 });
      const ac = new AbortController();
      const running = brain.run("spec", { prompt: "p" }, { signal: ac.signal });
      await untilExists(started);
      ac.abort();
      expect(await running).toMatchObject({ sessionId: "5e55a0a0-0000-4000-8000-000000000001", totalCostUsd: 0.0123 });
    });

    it("keeps the spend a killed child reports", async () => {
      const { brain, started } = setup("hang-report", { routing: fast(CAP), killGraceMs: 200 });
      const ac = new AbortController();
      const running = brain.run("spec", { prompt: "p" }, { signal: ac.signal }).catch((e) => e);
      await untilExists(started);
      ac.abort();
      expect(await running).toMatchObject({ kind: "interrupted", totalCostUsd: 0.004, sessionId: "5e55a0a0-0000-4000-8000-000000000001" });
    });
  });

  describe("build route", () => {
    it("runs in the given repo with acceptEdits, a scoped allowedTools (no bare Bash), stream-json and the caps", async () => {
      const { brain, calls } = setup("success");
      const repo = tempDir("argus-build-repo-");
      await brain.run("build", { prompt: "7", slash: "implement-spec" }, { cwd: repo });
      const { argv, cwd } = calls()[0]!;
      expect(cwd).toBe(repo);
      expect(argv.slice(0, 2)).toEqual(["-p", "/implement-spec 7"]);
      expect(argv[argv.indexOf("--permission-mode") + 1]).toBe("acceptEdits");
      expect(argv[argv.indexOf("--output-format") + 1]).toBe("stream-json");
      expect(argv).toContain("--verbose");
      expect(argv[argv.indexOf("--max-budget-usd") + 1]).toBe("25");
      expect(argv[argv.indexOf("--setting-sources") + 1]).toBe("project");
      expect(argv).toContain("--strict-mcp-config");
      const allowed = argv[argv.indexOf("--allowedTools") + 1]!.split(",");
      expect(allowed).not.toContain("Bash");
      expect(allowed).toEqual(expect.arrayContaining(["Edit", "Write", "Bash(git commit *)", "Bash(pnpm check*)"]));
      expect(allowed.some((t) => /wrangler|deploy|push|curl|rm /.test(t))).toBe(false);
      expect(DEFAULT_ROUTING.build.timeoutMs).toBe(240 * 60_000);
    });

    it("hands each stdout chunk to onOutput while the child runs", async () => {
      const { brain } = setup("success");
      const chunks: string[] = [];
      await brain.run("build", { prompt: "7" }, { onOutput: (c) => chunks.push(c) });
      const lines = chunks.join("").trim().split("\n").map((l) => JSON.parse(l) as { type: string });
      expect(lines.map((l) => l.type)).toEqual(["system", "rate_limit_event", "assistant", "result"]);
    });

    it("other routes keep json output and the plain /<task> prompt", async () => {
      const { brain, calls } = setup("success");
      await brain.run("spec", { prompt: "p" });
      const { argv } = calls()[0]!;
      expect(argv[1]).toBe("/spec\n\np");
      expect(argv[argv.indexOf("--output-format") + 1]).toBe("json");
      expect(argv).not.toContain("--permission-mode");
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
    const tmp = tempDir("argus-tmpdir-");
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

    describe("removes the temp dir on every terminal path", () => {
      const skillsDir = join(import.meta.dirname, "../../..", ".claude", "skills");
      const isolated = (mode: string) => setup(mode, { skillsDir, routing: resolveRouting({ spec: { timeoutMs: 60_000 } }), killGraceMs: 200 });

      it("failure", async () => {
        const { brain, calls } = isolated("failure");
        await expect(brain.run("spec", { prompt: "p" })).rejects.toBeInstanceOf(BrainError);
        expect(existsSync(calls()[0]!.cwd)).toBe(false);
      });

      it("timeout", async () => {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        try {
          const { brain, calls, started } = isolated("hang");
          const running = brain.run("spec", { prompt: "p" }).catch((e) => e);
          await untilExists(started);
          const cwd = calls()[0]!.cwd;
          expect(existsSync(cwd)).toBe(true);
          vi.advanceTimersByTime(60_000);
          expect(await running).toMatchObject({ kind: "timed-out" });
          expect(existsSync(cwd)).toBe(false);
        } finally {
          vi.useRealTimers();
        }
      });

      it("shutdown", async () => {
        const { brain, calls, started } = isolated("hang-stubborn");
        const running = brain.run("spec", { prompt: "p" }).catch((e) => e);
        await untilExists(started);
        const cwd = calls()[0]!.cwd;
        expect(existsSync(cwd)).toBe(true);
        await killLiveBrainChildren(200);
        expect(await running).toMatchObject({ kind: "interrupted" });
        expect(existsSync(cwd)).toBe(false);
      });
    });

    it("an explicit cwd wins over skillsDir", async () => {
      const dir = tempDir("argus-cwd-");
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

describe("sessionIdOf: the session a run is recorded under", () => {
  const ID = "5e55a0a0-0000-4000-8000-000000000001";
  const OTHER = "5e55a0a0-0000-4000-8000-000000000002";

  it("takes the result's session, then the stream's init message", () => {
    expect(sessionIdOf([{ type: "system", subtype: "init", session_id: OTHER }, { type: "result", session_id: ID }])).toBe(ID);
    expect(sessionIdOf([{ type: "system", subtype: "init", session_id: ID }])).toBe(ID);
  });

  it("ignores a session_id on any other message, even before the init", () => {
    expect(sessionIdOf([{ type: "rate_limit_event", session_id: OTHER }, { type: "assistant", session_id: OTHER }, { type: "system", subtype: "other", session_id: OTHER }])).toBeUndefined();
    expect(sessionIdOf([{ type: "user", session_id: OTHER }, { type: "system", subtype: "init", session_id: ID }])).toBe(ID);
  });

  it("stores only a UUID", () => {
    expect(sessionIdOf([{ type: "system", subtype: "init", session_id: "../../etc/passwd" }])).toBeUndefined();
    expect(sessionIdOf([{ type: "result", session_id: "not-a-uuid; rm -rf" }])).toBeUndefined();
  });
});
