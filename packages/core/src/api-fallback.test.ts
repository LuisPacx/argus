import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ApiBrain, ApiSpendCapError } from "./api-brain.ts";
import { anthropicKeyFromEnv, apiFallbackConfigFromEnv, FallbackBrain } from "./api-fallback.ts";
import { BrainError, ClaudeCodeBrain } from "./brain.ts";
import { FAKE_CLAUDE } from "./testing/fake-claude.ts";
import { messageBody, startFakeAnthropic, type FakeAnthropic, type FakeReply } from "./testing/fake-anthropic.ts";
import { tempDir } from "./testing/temp.ts";

const KEY = "sk-ant-test-0123456789abcdef";
const SKILLS = join(import.meta.dirname, "../../../.claude/skills");
const ANSWER = JSON.stringify({ scores: { momentum: 7, novelty: 6, buildability: 8, hook: 5, legitimacy: 9 }, rationale: "clear" });
/** The reset time the fake claude's rate-limit event reports (Unix seconds): 2026-11-05T00:40:00Z. */
const RESET = 1793839200;

let fake: FakeAnthropic | undefined;
afterEach(async () => {
  await fake?.close();
  fake = undefined;
});

async function setup(mode: string, over: { spentUsd?: () => number; dailyCapUsd?: number; dryRun?: boolean; outputFormat?: "json" | "stream-json"; replies?: FakeReply[] } = {}) {
  fake = await startFakeAnthropic();
  const dir = tempDir("argus-fallback-");
  const log = join(dir, "calls.jsonl");
  const lines: string[] = [];
  const clock = { now: new Date("2026-11-05T00:00:00.000Z") };
  const primary = new ClaudeCodeBrain({
    command: FAKE_CLAUDE,
    cwd: dir,
    env: { PATH: process.env.PATH, ANTHROPIC_API_KEY: KEY, FAKE_CLAUDE_MODE: mode, FAKE_CLAUDE_RESULT: ANSWER, FAKE_CLAUDE_LOG: log },
    passEnv: ["FAKE_CLAUDE_MODE", "FAKE_CLAUDE_RESULT", "FAKE_CLAUDE_LOG"],
    outputFormat: over.outputFormat,
    dryRun: over.dryRun,
    log: (l) => lines.push(l),
    killGraceMs: 200,
  });
  fake.reply(...(over.replies ?? [{ status: 200, body: messageBody(ANSWER, { input_tokens: 1000, output_tokens: 100 }) }]));
  const api = new ApiBrain({
    apiKey: KEY,
    baseUrl: fake.url,
    skillsDir: SKILLS,
    spentUsd: over.spentUsd ?? (() => 0),
    dailyCapUsd: over.dailyCapUsd,
    dryRun: over.dryRun,
    log: (l) => lines.push(l),
  });
  const brain = new FallbackBrain({ primary, api, now: () => clock.now, dryRun: over.dryRun, log: (l) => lines.push(l) });
  const claudeCalls = () => (existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { argv: string[]; env: Record<string, string> }) : []);
  return { brain, fake, claudeCalls, lines, clock };
}

const caught = async (p: Promise<unknown>): Promise<BrainError> => {
  try {
    await p;
  } catch (e) {
    return e as BrainError;
  }
  throw new Error("expected the run to fail");
};

describe("FallbackBrain: when the subscription window is exhausted", () => {
  it("runs on claude and never touches the API while the subscription answers", async () => {
    const { brain, fake, claudeCalls } = await setup("success");
    const run = await brain.run<string>("judge", { prompt: "p" });
    expect(run).toMatchObject({ backend: "claude-code", model: "haiku" });
    expect(claudeCalls()).toHaveLength(1);
    expect(fake.requests).toHaveLength(0);
    expect(brain.routeFor("judge")).toMatchObject({ backend: "claude-code", model: "haiku" });
  });

  for (const [mode, format] of [["ratelimit", "json"], ["ratelimit-structured", "json"], ["ratelimit-event", "stream-json"], ["noresult-ratelimit", "json"]] as const) {
    it(`a rate-limited judge run (${mode}) is served by the API instead, once`, async () => {
      const { brain, fake, claudeCalls } = await setup(mode, { outputFormat: format });
      const run = await brain.run<string>("judge", { prompt: "p" });
      expect(run).toMatchObject({ output: ANSWER, backend: "api", model: "claude-haiku-5-5" });
      expect(run.totalCostUsd).toBeCloseTo((1000 * 0.1 + 100 * 0.5) / 1e6, 10);
      expect(claudeCalls()).toHaveLength(1);
      expect(fake.requests).toHaveLength(1);
    });
  }

  it("a rate-limited propose run falls back too", async () => {
    const { brain, fake } = await setup("ratelimit");
    expect(await brain.run("propose", { prompt: "p" })).toMatchObject({ backend: "api" });
    expect(String(fake.requests[0]!.body.system)).toContain("# Propose");
  });

  it("then judge and propose go straight to the API for the rest of the window, without asking claude again; routeFor says so", async () => {
    const { brain, fake, claudeCalls } = await setup("ratelimit");
    await brain.run("judge", { prompt: "p" });
    fake.reply({ status: 200, body: messageBody(ANSWER) }, { status: 200, body: messageBody(ANSWER) });
    expect(brain.routeFor("judge")).toMatchObject({ backend: "api", model: "claude-haiku-5-5" });
    expect(brain.routeFor("propose")).toMatchObject({ backend: "api" });
    expect(brain.routeFor("spec")).toMatchObject({ backend: "claude-code" });
    await brain.run("judge", { prompt: "p" });
    await brain.run("propose", { prompt: "p" });
    expect(claudeCalls()).toHaveLength(1);
    expect(fake.requests).toHaveLength(3);
  });

  it("the Est. usage caps still come from the subscription routes while the API serves", async () => {
    const { brain } = await setup("ratelimit");
    await brain.run("judge", { prompt: "p" });
    expect(brain.primaryRouteFor("judge")).toMatchObject({ backend: "claude-code", maxBudgetUsd: 0.1 });
    expect(brain.primaryRouteFor("propose")).toMatchObject({ backend: "claude-code", maxBudgetUsd: 1 });
  });

  it("until the window resets: when claude names the reset time the API serves up to it, and claude is asked again after", async () => {
    const { brain, fake, claudeCalls, clock } = await setup("ratelimit-event", { outputFormat: "stream-json" });
    clock.now = new Date((RESET - 7200) * 1000); // two hours before the reset
    await brain.run("judge", { prompt: "p" });
    fake.reply({ status: 200, body: messageBody(ANSWER) });
    clock.now = new Date((RESET - 60) * 1000);
    await brain.run("judge", { prompt: "p" });
    expect(claudeCalls()).toHaveLength(1);
    clock.now = new Date((RESET + 1) * 1000);
    expect(brain.routeFor("judge")).toMatchObject({ backend: "claude-code" });
    fake.reply({ status: 200, body: messageBody(ANSWER) });
    await brain.run("judge", { prompt: "p" }); // claude is rate-limited again, so the API serves again
    expect(claudeCalls()).toHaveLength(2);
  });

  it("when claude names no time, the hold is short (15 minutes), so the subscription is tried again soon", async () => {
    const { brain, fake, claudeCalls, clock } = await setup("ratelimit");
    await brain.run("judge", { prompt: "p" });
    fake.reply({ status: 200, body: messageBody(ANSWER) });
    clock.now = new Date(clock.now.getTime() + 14 * 60_000);
    await brain.run("judge", { prompt: "p" });
    expect(claudeCalls()).toHaveLength(1);
    clock.now = new Date(clock.now.getTime() + 2 * 60_000);
    fake.reply({ status: 200, body: messageBody(ANSWER) });
    await brain.run("judge", { prompt: "p" });
    expect(claudeCalls()).toHaveLength(2);
  });

  it("a reset time that is in the past, or further than 6 hours away, is not trusted past those bounds", async () => {
    const past = await setup("ratelimit-event", { outputFormat: "stream-json" });
    past.clock.now = new Date((RESET + 3600) * 1000); // the reported reset is an hour ago
    await past.brain.run("judge", { prompt: "p" });
    past.clock.now = new Date(past.clock.now.getTime() + 16 * 60_000);
    expect(past.brain.routeFor("judge")).toMatchObject({ backend: "claude-code" }); // default hold of 15 minutes, not forever
    await past.fake.close();
    const far = await setup("ratelimit-event", { outputFormat: "stream-json" });
    far.clock.now = new Date((RESET - 3 * 86_400) * 1000); // the reset is three days away
    await far.brain.run("judge", { prompt: "p" });
    far.clock.now = new Date(far.clock.now.getTime() + 6 * 3_600_000 + 60_000);
    expect(far.brain.routeFor("judge")).toMatchObject({ backend: "claude-code" });
  });
});

describe("FallbackBrain: spec and build never fall back", () => {
  it("a rate-limited spec run fails as before and the API is not called", async () => {
    const { brain, fake } = await setup("ratelimit");
    const e = await caught(brain.run("spec", { prompt: "p" }));
    expect(e).toMatchObject({ kind: "rate-limited", backend: "claude-code" });
    expect(fake.requests).toHaveLength(0);
  });

  it("a rate-limited build run fails as before and the API is not called", async () => {
    const { brain, fake } = await setup("ratelimit");
    expect(await caught(brain.run("build", { prompt: "p", slash: "implement-spec" }))).toMatchObject({ kind: "rate-limited" });
    expect(fake.requests).toHaveLength(0);
  });

  it("the window is one window: after a spec run is throttled, judge and propose use the API, while spec still asks claude", async () => {
    const { brain, fake, claudeCalls } = await setup("ratelimit");
    await caught(brain.run("spec", { prompt: "p" }));
    expect(await brain.run("judge", { prompt: "p" })).toMatchObject({ backend: "api" });
    expect(claudeCalls()).toHaveLength(1);
    expect(brain.routeFor("spec")).toMatchObject({ backend: "claude-code" });
    await caught(brain.run("spec", { prompt: "p" }));
    expect(claudeCalls()).toHaveLength(2);
    expect(fake.requests).toHaveLength(1);
  });
});

describe("FallbackBrain: only a rate limit triggers it", () => {
  it("a failed or over-budget claude run is not retried on the API", async () => {
    for (const mode of ["failure", "budget", "failure-429text", "noresult"]) {
      const { brain, fake } = await setup(mode);
      const e = await caught(brain.run("judge", { prompt: "p" }));
      expect(e.kind, mode).not.toBe("rate-limited");
      expect(e.backend).toBe("claude-code");
      expect(fake.requests, mode).toHaveLength(0);
      await fake.close();
    }
  });
});

describe("FallbackBrain: the daily real-dollar cap", () => {
  it("when the API cannot take over because its cap is reached, the run fails as the rate limit it was and nothing is sent", async () => {
    const { brain, fake } = await setup("ratelimit", { spentUsd: () => 0.5, dailyCapUsd: 0.5 });
    const e = await caught(brain.run("judge", { prompt: "p" }));
    expect(e).toMatchObject({ kind: "rate-limited", backend: "claude-code" });
    expect(fake.requests).toHaveLength(0);
  });

  it("during the hold, a reached cap stops judge and propose with a rate-limited error from the API side, again sending nothing", async () => {
    let spent = 0;
    const { brain, fake } = await setup("ratelimit", { spentUsd: () => spent, dailyCapUsd: 0.5 });
    await brain.run("judge", { prompt: "p" });
    spent = 0.4999;
    const e = await caught(brain.run("judge", { prompt: "p" }));
    expect(e).toBeInstanceOf(ApiSpendCapError);
    expect(e.kind).toBe("rate-limited");
    expect(fake.requests).toHaveLength(1);
  });

  it("an API failure after the hand-over is the run's failure, with its cost counted against the cap", async () => {
    const { brain } = await setup("ratelimit", { replies: [{ status: 500, body: { type: "error", error: { type: "api_error", message: "x" } } }] });
    const e = await caught(brain.run("judge", { prompt: "p" }));
    expect(e).toMatchObject({ kind: "failed", backend: "api", model: "claude-haiku-5-5" });
    expect(e.totalCostUsd).toBeGreaterThan(0);
  });
});

describe("FallbackBrain: the key stays out of claude", () => {
  it("no claude child ever sees ANTHROPIC_API_KEY or the key's value, whether it was the first call or after the hand-over", async () => {
    const { brain, claudeCalls } = await setup("ratelimit");
    await brain.run("judge", { prompt: "p" });
    await caught(brain.run("spec", { prompt: "p" }));
    const calls = claudeCalls();
    expect(calls.length).toBeGreaterThanOrEqual(2);
    for (const c of calls) {
      expect(c.env.ANTHROPIC_API_KEY).toBeUndefined();
      expect(JSON.stringify(c)).not.toContain(KEY);
    }
  });
});

describe("FallbackBrain: dry run", () => {
  it("logs what claude would be asked and the API request it would fall back to, and spawns and sends nothing", async () => {
    const { brain, fake, claudeCalls, lines } = await setup("ratelimit", { dryRun: true });
    const run = await brain.run("judge", { prompt: "Score this." });
    expect(run.dryRun).toBe(true);
    expect(claudeCalls()).toHaveLength(0);
    expect(fake.requests).toHaveLength(0);
    const text = lines.join("\n");
    expect(text).toMatch(/\[brain\] dry-run: .*--model haiku/);
    expect(text).toMatch(/\[brain\] dry-run: POST .*\/v1\/messages model=claude-haiku-5-5/);
    expect(text).not.toContain(KEY);
  });
});

describe("the fallback's configuration", () => {
  it("is off unless ARGUS_API_FALLBACK=1, with the cap in code as the default", () => {
    expect(apiFallbackConfigFromEnv({})).toEqual({ enabled: false, dailyUsd: 0.5 });
    expect(apiFallbackConfigFromEnv({ ARGUS_API_FALLBACK: "" })).toMatchObject({ enabled: false });
    expect(apiFallbackConfigFromEnv({ ARGUS_API_FALLBACK: "0" })).toMatchObject({ enabled: false });
    expect(apiFallbackConfigFromEnv({ ARGUS_API_FALLBACK: "1" })).toEqual({ enabled: true, dailyUsd: 0.5 });
  });

  it("anything else for the switch is an error, not a guess", () => {
    for (const v of ["yes", "true", "2", " 1x"]) expect(() => apiFallbackConfigFromEnv({ ARGUS_API_FALLBACK: v }), v).toThrow(/ARGUS_API_FALLBACK/);
  });

  it("ARGUS_API_DAILY_USD can only lower the cap: parsed first, then validated against the one in code", () => {
    expect(apiFallbackConfigFromEnv({ ARGUS_API_FALLBACK: "1", ARGUS_API_DAILY_USD: "0.1" }).dailyUsd).toBe(0.1);
    expect(apiFallbackConfigFromEnv({ ARGUS_API_DAILY_USD: "" }).dailyUsd).toBe(0.5);
    for (const v of ["0.51", "5", "1e3", "0", "-1", "abc", "NaN", "Infinity"]) expect(() => apiFallbackConfigFromEnv({ ARGUS_API_DAILY_USD: v }), v).toThrow(/ARGUS_API_DAILY_USD/);
  });
});

describe("the key", () => {
  const envFile = (text: string) => {
    const file = join(tempDir("argus-key-"), ".env");
    writeFileSync(file, text);
    return file;
  };

  it("comes from the process environment first", () => {
    expect(anthropicKeyFromEnv({ ANTHROPIC_API_KEY: KEY }, envFile("ANTHROPIC_API_KEY=from-file"))).toBe(KEY);
  });

  it("else from the git-ignored .env file", () => {
    expect(anthropicKeyFromEnv({}, envFile(`OTHER=1\nANTHROPIC_API_KEY=${KEY}\n`))).toBe(KEY);
  });

  it("a variable that is set, even to the empty string, wins over the file (so a test or an Operator can mask it)", () => {
    expect(anthropicKeyFromEnv({ ANTHROPIC_API_KEY: "" }, envFile(`ANTHROPIC_API_KEY=${KEY}`))).toBeUndefined();
  });

  it("ARGUS_NO_DOTENV means the file is never read", () => {
    expect(anthropicKeyFromEnv({ ARGUS_NO_DOTENV: "1" }, envFile(`ANTHROPIC_API_KEY=${KEY}`))).toBeUndefined();
  });

  it("is undefined when absent, blank or the file is missing", () => {
    expect(anthropicKeyFromEnv({}, join(tempDir("argus-key-"), "missing.env"))).toBeUndefined();
    expect(anthropicKeyFromEnv({}, envFile("ANTHROPIC_API_KEY=   \n"))).toBeUndefined();
  });

  it("takes only that one name from the file", () => {
    const got = anthropicKeyFromEnv({}, envFile(`TELEGRAM_BOT_TOKEN=t\nANTHROPIC_API_KEY=${KEY}`));
    expect(got).toBe(KEY);
  });
});
