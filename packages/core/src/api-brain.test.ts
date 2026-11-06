import { join } from "node:path";
import { inspect } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { ApiBrain, API_DEFAULT_ROUTING, apiCostUsd, MAX_API_DAILY_USD, type ApiBrainOptions } from "./api-brain.ts";
import { BrainError } from "./brain.ts";
import { Datastore } from "./datastore.ts";
import { parseJudgeOutput } from "./judge.ts";
import { messageBody, startFakeAnthropic, type FakeAnthropic } from "./testing/fake-anthropic.ts";

const RUBRIC = Datastore.open(":memory:").getRubric();
const KEY = "sk-ant-test-0123456789abcdef";
const SKILLS = join(import.meta.dirname, "../../../.claude/skills");
const ANSWER = JSON.stringify({ scores: { momentum: 7, novelty: 6, buildability: 8, hook: 5, legitimacy: 9 }, rationale: "clear" });

let fake: FakeAnthropic | undefined;
afterEach(async () => {
  await fake?.close();
  fake = undefined;
});

async function setup(over: Partial<ApiBrainOptions> = {}) {
  fake = await startFakeAnthropic();
  const lines: string[] = [];
  const brain = new ApiBrain({ apiKey: KEY, baseUrl: fake.url, skillsDir: SKILLS, spentUsd: () => 0, log: (l) => lines.push(l), ...over });
  return { brain, fake, lines };
}

async function untilRequests(f: FakeAnthropic, n: number): Promise<void> {
  for (let i = 0; i < 200 && f.requests.length < n; i++) await new Promise((r) => setTimeout(r, 25));
  expect(f.requests.length).toBeGreaterThanOrEqual(n);
}

const caught = async (p: Promise<unknown>): Promise<BrainError> => {
  try {
    await p;
  } catch (e) {
    return e as BrainError;
  }
  throw new Error("expected the run to fail");
};

describe("ApiBrain: one run", () => {
  it("sends the skill markdown as the system prompt and the task input as the user message, on haiku, with no tools", async () => {
    const { brain, fake } = await setup();
    fake.reply({ status: 200, body: messageBody(ANSWER, { input_tokens: 1000, output_tokens: 200 }) });
    const run = await brain.run<string>("judge", { prompt: "Score the Narrative below." });
    expect(fake.requests).toHaveLength(1);
    const req = fake.requests[0]!;
    expect(req.method).toBe("POST");
    expect(req.path).toBe("/v1/messages");
    expect(req.body.model).toBe("claude-haiku-5-5");
    expect(req.body.messages).toEqual([{ role: "user", content: "Score the Narrative below." }]);
    const system = String(req.body.system);
    expect(system).toContain("# Judge");
    expect(system).toContain("Output contract");
    expect(system).not.toContain("name: judge"); // the front matter is not part of the prompt
    expect(system).toMatch(/no tools/i);
    expect(req.body.tools).toBeUndefined();
    expect(req.body.temperature).toBeUndefined();
    expect(typeof req.body.max_tokens).toBe("number");
    expect(run).toMatchObject({ output: ANSWER, backend: "api", model: "claude-haiku-5-5" });
    expect(run.sessionId).toBeUndefined();
  });

  it("computes the cost from the provider's reported usage times the model's price (haiku 5.5: $0.10 in, $0.50 out per million)", async () => {
    const { brain, fake } = await setup();
    fake.reply({ status: 200, body: messageBody(ANSWER, { input_tokens: 1000, output_tokens: 200 }) });
    const run = await brain.run("judge", { prompt: "p" });
    expect(run.totalCostUsd).toBeCloseTo(0.0002, 10); // (1000 x 0.10 + 200 x 0.50) / 1e6
    // Cache tokens are charged at the dearest rate they can have (cache writes 1.25 x input), never less.
    expect(apiCostUsd("claude-haiku-5-5", { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 1_000_000, cache_read_input_tokens: 1_000_000 })).toBeCloseTo(0.1 * 1.25 + 0.1, 10);
  });

  it("an answer is the model's raw text and stays untrusted: the strict judge parser still decides what is stored", async () => {
    const { brain, fake } = await setup();
    fake.reply({ status: 200, body: messageBody("Sure! Here you go:\n" + ANSWER) }, { status: 200, body: messageBody(ANSWER) });
    const bad = await brain.run<string>("judge", { prompt: "p" });
    expect(parseJudgeOutput(bad.output, RUBRIC)).toMatchObject({ ok: false });
    const good = await brain.run<string>("judge", { prompt: "p" });
    expect(parseJudgeOutput(good.output, RUBRIC)).toMatchObject({ ok: true });
  });

  it("only judge and propose can run on the API: spec and build are refused without a request", async () => {
    const { brain, fake } = await setup();
    for (const task of ["spec", "build"] as const) {
      const e = await caught(brain.run(task, { prompt: "p" }));
      expect(e).toMatchObject({ kind: "failed", backend: "api" });
      expect(e.message).toMatch(/judge and propose/);
    }
    expect(fake.requests).toHaveLength(0);
    expect(() => brain.routeFor("spec")).toThrow(/judge and propose/);
  });

  it("the routes are haiku with small per-run caps", () => {
    expect(API_DEFAULT_ROUTING.judge.model).toBe("claude-haiku-5-5");
    expect(API_DEFAULT_ROUTING.propose.model).toBe("claude-haiku-5-5");
    expect(API_DEFAULT_ROUTING.judge.maxBudgetUsd).toBeLessThanOrEqual(0.05);
    expect(API_DEFAULT_ROUTING.propose.maxBudgetUsd).toBeLessThanOrEqual(0.1);
  });

  it("a model without a known price cannot be configured (fail closed)", () => {
    expect(() => new ApiBrain({ apiKey: KEY, skillsDir: SKILLS, spentUsd: () => 0, routing: { judge: { ...API_DEFAULT_ROUTING.judge, model: "claude-mystery-9" } } })).toThrow(/no known price/);
  });

  it("does not take its endpoint or key from the environment the SDK reads", async () => {
    const { brain, fake } = await setup();
    const saved = { b: process.env.ANTHROPIC_BASE_URL, t: process.env.ANTHROPIC_AUTH_TOKEN };
    process.env.ANTHROPIC_BASE_URL = "http://127.0.0.1:1";
    process.env.ANTHROPIC_AUTH_TOKEN = "other-credential";
    try {
      fake.reply({ status: 200, body: messageBody(ANSWER) });
      await brain.run("judge", { prompt: "p" });
      expect(fake.requests).toHaveLength(1);
      expect(JSON.stringify(fake.requests[0]!.headers)).not.toContain("other-credential");
      expect(JSON.stringify(fake.requests[0]!.headers)).toContain(KEY); // the Operator's key, sent to the configured endpoint only
    } finally {
      if (saved.b === undefined) delete process.env.ANTHROPIC_BASE_URL;
      else process.env.ANTHROPIC_BASE_URL = saved.b;
      if (saved.t === undefined) delete process.env.ANTHROPIC_AUTH_TOKEN;
      else process.env.ANTHROPIC_AUTH_TOKEN = saved.t;
    }
  });
});

describe("ApiBrain: dry run", () => {
  it("logs the request it would send and sends nothing, needing no key", async () => {
    fake = await startFakeAnthropic();
    const lines: string[] = [];
    const brain = new ApiBrain({ dryRun: true, baseUrl: fake.url, skillsDir: SKILLS, spentUsd: () => 0, log: (l) => lines.push(l) });
    const run = await brain.run("propose", { prompt: "Propose a token." });
    expect(run).toMatchObject({ dryRun: true, totalCostUsd: 0, backend: "api", model: "claude-haiku-5-5" });
    expect(fake.requests).toHaveLength(0);
    const text = lines.join("\n");
    expect(text).toMatch(/dry-run/);
    expect(text).toContain("claude-haiku-5-5");
    expect(text).toContain("Propose a token.");
  });
});

describe("ApiBrain: the daily real-dollar cap", () => {
  it("the cap in code is small, and the default is that cap", () => {
    expect(MAX_API_DAILY_USD).toBeLessThanOrEqual(0.5);
  });

  it("refuses before the call when what is spent plus what this call could cost would pass the cap: no request is made", async () => {
    const { brain, fake } = await setup({ dailyCapUsd: 0.05, spentUsd: () => 0.0499 });
    const e = await caught(brain.run("judge", { prompt: "p" }));
    expect(e).toMatchObject({ kind: "rate-limited", backend: "api", totalCostUsd: 0 });
    expect(e.message).toMatch(/daily cap/i);
    expect(fake.requests).toHaveLength(0);
  });

  it("runs while there is room", async () => {
    const { brain, fake } = await setup({ dailyCapUsd: 0.05, spentUsd: () => 0.01 });
    await brain.run("judge", { prompt: "p" });
    expect(fake.requests).toHaveLength(1);
  });

  it("fails closed when the spend cannot be read or is nonsense", async () => {
    for (const spentUsd of [() => Number.NaN, () => -1, () => { throw new Error("db locked"); }]) {
      const { brain, fake } = await setup({ spentUsd });
      const e = await caught(brain.run("judge", { prompt: "p" }));
      expect(e).toMatchObject({ kind: "failed", backend: "api" });
      expect(fake.requests).toHaveLength(0);
      await fake.close();
    }
  });

  it("a cap above the one in code is refused, never honoured; a lower one is", () => {
    expect(() => new ApiBrain({ apiKey: KEY, skillsDir: SKILLS, spentUsd: () => 0, dailyCapUsd: MAX_API_DAILY_USD + 0.01 })).toThrow(/at most/);
    expect(() => new ApiBrain({ apiKey: KEY, skillsDir: SKILLS, spentUsd: () => 0, dailyCapUsd: 0 })).toThrow(/positive/);
    expect(() => new ApiBrain({ apiKey: KEY, skillsDir: SKILLS, spentUsd: () => 0, dailyCapUsd: 0.01 })).not.toThrow();
  });

  it("a prompt too big for the per-run cap is refused before the call", async () => {
    const { brain, fake } = await setup();
    const e = await caught(brain.run("judge", { prompt: "x".repeat(500_000) }));
    expect(e).toMatchObject({ kind: "budget-exceeded", backend: "api", totalCostUsd: 0 });
    expect(fake.requests).toHaveLength(0);
  });
});

describe("ApiBrain: failed and partial calls are counted", () => {
  it("a rejected request (4xx) was not billed: failed at $0", async () => {
    const { brain, fake } = await setup();
    fake.reply({ status: 400, body: { type: "error", error: { type: "invalid_request_error", message: "bad" } } });
    expect(await caught(brain.run("judge", { prompt: "p" }))).toMatchObject({ kind: "failed", totalCostUsd: 0 });
  });

  it("an API rate limit (429) stops research without a charge", async () => {
    const { brain, fake } = await setup();
    fake.reply({ status: 429, body: { type: "error", error: { type: "rate_limit_error", message: "slow down" } } });
    expect(await caught(brain.run("judge", { prompt: "p" }))).toMatchObject({ kind: "rate-limited", totalCostUsd: 0 });
  });

  it("a server error and a cut connection have unknown cost: charged at the call's ceiling, which is above zero and within the per-run cap", async () => {
    const { brain, fake } = await setup();
    fake.reply({ status: 500, body: { type: "error", error: { type: "api_error", message: "oops" } } }, { destroy: true });
    for (let i = 0; i < 2; i++) {
      const e = await caught(brain.run("judge", { prompt: "p" }));
      expect(e.kind).toBe("failed");
      expect(e.totalCostUsd).toBeGreaterThan(0);
      expect(e.totalCostUsd).toBeLessThanOrEqual(API_DEFAULT_ROUTING.judge.maxBudgetUsd);
    }
  });

  it("an answer that reports no usage is returned, charged at the call's ceiling", async () => {
    const { brain, fake } = await setup();
    fake.reply({ status: 200, body: messageBody(ANSWER, null) });
    const run = await brain.run<string>("judge", { prompt: "p" });
    expect(run.output).toBe(ANSWER);
    expect(run.totalCostUsd).toBeGreaterThan(0.0005);
    expect(run.totalCostUsd).toBeLessThanOrEqual(API_DEFAULT_ROUTING.judge.maxBudgetUsd);
  });

  it("an answer cut at max_tokens costs what it reported and is still returned, for the strict parser to refuse", async () => {
    const { brain, fake } = await setup();
    fake.reply({ status: 200, body: messageBody('{"scores": {"mom', { input_tokens: 500, output_tokens: 1024 }, { stop_reason: "max_tokens" }) });
    const run = await brain.run<string>("judge", { prompt: "p" });
    expect(run.output).toBe('{"scores": {"mom');
    expect(run.totalCostUsd).toBeCloseTo((500 * 0.1 + 1024 * 0.5) / 1e6, 10);
  });

  it("an answer with no text fails but keeps the cost it reported", async () => {
    const { brain, fake } = await setup();
    fake.reply({ status: 200, body: messageBody("", { input_tokens: 500, output_tokens: 3 }, { content: [], stop_reason: "refusal" }) });
    const e = await caught(brain.run("judge", { prompt: "p" }));
    expect(e).toMatchObject({ kind: "failed" });
    expect(e.totalCostUsd).toBeCloseTo((500 * 0.1 + 3 * 0.5) / 1e6, 10);
  });

  it("a call that outlives its timeout fails as timed out and is charged at its ceiling, since the server may still have served it", async () => {
    const { brain, fake } = await setup({ routing: { judge: { ...API_DEFAULT_ROUTING.judge, timeoutMs: 100 } } });
    fake.reply({ status: 200, body: messageBody(ANSWER), delayMs: 1500 });
    const e = await caught(brain.run("judge", { prompt: "p" }));
    expect(e).toMatchObject({ kind: "failed", backend: "api" });
    expect(e.message).toMatch(/timed out/);
    expect(e.totalCostUsd).toBeGreaterThan(0);
    expect(fake.requests).toHaveLength(1); // not retried: a retry would be a second bill
  });

  it("a call aborted while in flight is interrupted and charged at its ceiling", async () => {
    const { brain, fake } = await setup();
    fake.reply({ status: 200, body: messageBody(ANSWER), delayMs: 1500 });
    const ctl = new AbortController();
    const running = caught(brain.run("judge", { prompt: "p" }, { signal: ctl.signal }));
    await untilRequests(fake, 1);
    ctl.abort();
    const e = await running;
    expect(e.kind).toBe("interrupted");
    expect(e.totalCostUsd).toBeGreaterThan(0);
  });

  it("an aborted run that was never sent costs nothing", async () => {
    const { brain } = await setup();
    const ctl = new AbortController();
    ctl.abort();
    const e = await caught(brain.run("judge", { prompt: "p" }, { signal: ctl.signal }));
    expect(e.kind).toBe("interrupted");
    expect(e.totalCostUsd).toBe(0); // aborted before any request was made: nothing was sent
  });
});

describe("ApiBrain: the key is never exposed", () => {
  it("is sent to the endpoint, and appears in no error, no log line and no inspected object, even when the server echoes it", async () => {
    const { brain, fake, lines } = await setup();
    // A hostile or buggy server that repeats the credential it was given in its error text.
    fake.reply({ status: 401, body: { type: "error", error: { type: "authentication_error", message: `invalid key ${KEY} (Bearer ${KEY})` } } });
    const e = await caught(brain.run("judge", { prompt: "p" }));
    const seen = [e.message, e.stack ?? "", inspect(e, { depth: 12, showHidden: true }), JSON.stringify(e), inspect(brain, { depth: 12, showHidden: true }), lines.join("\n")];
    for (const s of seen) expect(s).not.toContain(KEY);
    expect((e as { cause?: unknown }).cause).toBeUndefined();
  });

  it("a connection failure carries no cause chain either", async () => {
    const { brain, fake } = await setup();
    fake.reply({ destroy: true });
    const e = await caught(brain.run("judge", { prompt: "p" }));
    expect((e as { cause?: unknown }).cause).toBeUndefined();
    expect(inspect(e, { depth: 12, showHidden: true })).not.toContain(KEY);
  });

  it("a key that is not a plain token is refused at construction, without echoing it", () => {
    let message = "";
    try {
      new ApiBrain({ apiKey: "bad key\nwith newline", skillsDir: SKILLS, spentUsd: () => 0 });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toMatch(/ANTHROPIC_API_KEY/);
    expect(message).not.toContain("bad key");
  });
});
