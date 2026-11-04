import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BrainError, ClaudeCodeBrain, resolveRouting, scrubEnv } from "./brain.ts";
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
    },
    passEnv: ["FAKE_CLAUDE_MODE", "FAKE_CLAUDE_LOG"],
    ...extra,
  });
  const calls = () =>
    readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l) as { argv: string[]; env: Record<string, string> });
  return { brain, calls, log };
}

describe("ClaudeCodeBrain", () => {
  for (const format of ["json", "stream-json"] as const) {
    it(`returns output, session and cost on success (${format})`, async () => {
      const { brain } = setup("success", { outputFormat: format });
      const run = await brain.run<string>("spec", { prompt: "p" });
      expect(run).toMatchObject({ output: "# Spec\n\nA fake Spec.\n", sessionId: "fake-session-1", totalCostUsd: 0.0123, backend: "claude-code", model: "sonnet" });
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

  it("--dry-run logs the command and spawns nothing", async () => {
    const lines: string[] = [];
    const { brain, log } = setup("success", { dryRun: true, log: (l) => lines.push(l) });
    const run = await brain.run("spec", { prompt: "p" });
    expect(run.dryRun).toBe(true);
    expect(lines.join("\n")).toContain("--max-budget-usd 2");
    expect(() => readFileSync(log)).toThrow();
  });
});
