import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { describe, expect, it } from "vitest";
import { ApiBrain, anthropicBaseUrl } from "../api-brain.ts";
import { ClaudeCodeBrain, killLiveBrainChildren } from "../brain.ts";
import { FAKE_CLAUDE } from "./fake-claude.ts";
import { failOnAnthropicCalls, failOnRealClaude, leakedIn, runAll, startAnthropicTripwire, sweepTempRoot, writeClaudeTripwire } from "./no-leaked-fakes.ts";
import { registryDirFor } from "./run-registry.mjs";
import { tempDir } from "./temp.ts";
import { untilExists } from "./wait.ts";

describe("the leak guard only claims fakes started under its own test run", () => {
  it("a fake records itself with the run whose process is its ancestor, not with another run's registry", async () => {
    const dir = mkdtempSync(join(tmpdir(), "argus-registry-test-"));
    const started = join(dir, "started");
    // This test's own worker is the fake's ancestor, so its registry is the one the fake must pick. The other is some other run.
    const mine = registryDirFor(process.pid);
    const other = registryDirFor(process.pid + 1_000_000);
    mkdirSync(mine, { recursive: true });
    mkdirSync(other, { recursive: true });
    const child = spawn(join(import.meta.dirname, "fake-wrangler.mjs"), [], {
      env: { PATH: process.env.PATH, FAKE_WRANGLER_HANG: "1", FAKE_WRANGLER_STARTED: started },
      stdio: "ignore",
      detached: true,
    });
    try {
      await untilExists(started);
      expect(readdirSync(mine)).toEqual([String(child.pid)]);
      expect(leakedIn(mine).map((l) => l.pid)).toEqual([child.pid]);
      // The other run neither holds the fake nor would report it.
      expect(readdirSync(other)).toEqual([]);
      expect(leakedIn(other)).toEqual([]);
    } finally {
      process.kill(child.pid!, "SIGKILL");
      rmSync(mine, { recursive: true, force: true });
      rmSync(other, { recursive: true, force: true });
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("the registry is on the home disk, not under the TMPDIR or /tmp", () => {
    expect(registryDirFor(1)).toMatch(/\/node_modules\/\.cache\/argus-fakes\/1$/);
  });

  it("a fake that finds its run's registry but cannot write to it fails loudly", () => {
    const mine = registryDirFor(process.pid);
    mkdirSync(mine, { recursive: true });
    chmodSync(mine, 0o500);
    try {
      const r = spawnSync(join(import.meta.dirname, "fake-gh.mjs"), [], { env: { PATH: process.env.PATH }, encoding: "utf8" });
      expect(r.status).not.toBe(0);
      expect(r.stderr).toMatch(/EACCES/);
    } finally {
      chmodSync(mine, 0o700);
      rmSync(mine, { recursive: true, force: true });
    }
  });

  it("a recorded process that is gone, or whose pid was reused by something else, is not a leak", () => {
    const dir = mkdtempSync(join(tmpdir(), "argus-registry-test-"));
    try {
      // This very test process, recorded with a start time that is not its own (a reused pid), and a pid that does not exist.
      writeFileSync(join(dir, String(process.pid)), "1");
      writeFileSync(join(dir, "2000000000"), "1");
      expect(leakedIn(dir)).toEqual([]);
      expect(leakedIn(join(dir, "missing"))).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a fake claude started through the brain registers with this run, so a leaked one would be caught", async () => {
    const dir = tempDir("argus-registry-test-");
    const started = join(dir, "started");
    const mine = registryDirFor(process.pid);
    mkdirSync(mine, { recursive: true });
    // The scrubbed env shape the brain tests use: no TMPDIR or HOME, and the fake still finds the registry.
    const brain = new ClaudeCodeBrain({
      command: FAKE_CLAUDE,
      cwd: dir,
      env: { PATH: process.env.PATH, FAKE_CLAUDE_MODE: "hang-stubborn", FAKE_CLAUDE_STARTED: started },
      passEnv: ["FAKE_CLAUDE_MODE", "FAKE_CLAUDE_STARTED"],
      killGraceMs: 200,
    });
    const running = brain.run("spec", { prompt: "p" }).catch((e) => e);
    try {
      await untilExists(started);
      expect(leakedIn(mine).length).toBeGreaterThan(0);
    } finally {
      await killLiveBrainChildren(200);
      await running;
      rmSync(mine, { recursive: true, force: true });
    }
  });

  it("a bare `claude` on PATH is the guard's tripwire, never the Operator's real one", () => {
    const first = process.env.PATH!.split(delimiter)[0]!;
    expect(readFileSync(join(first, "claude"), "utf8")).toContain("blocked by the test run's guard");
  });

  it("the tripwire runs nothing, exits 127, records the call, and the guard then fails the run naming its arguments", () => {
    const dir = tempDir("argus-tripwire-");
    expect(() => failOnRealClaude(dir)).not.toThrow(); // no call, no failure
    const bin = writeClaudeTripwire(dir);
    const r = spawnSync(join(bin, "claude"), ["-p", "/judge Score this", "--model", "haiku"], { encoding: "utf8" });
    expect(r.status).toBe(127);
    expect(r.stderr).toContain("blocked by the test run's guard");
    expect(() => failOnRealClaude(dir)).toThrow(/tried to start the real `claude` 1 time[\s\S]*-p \/judge Score this --model haiku/);
  });

  it("the Anthropic API is walled off: the default endpoint is the run's loopback tripwire and no key reaches the test process", () => {
    expect(anthropicBaseUrl()).toBe(process.env.ARGUS_ANTHROPIC_URL);
    expect(process.env.ARGUS_ANTHROPIC_URL).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(process.env.ANTHROPIC_BASE_URL).toBe(process.env.ARGUS_ANTHROPIC_URL); // the SDK's own variable points there too
    expect(process.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(process.env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
  });

  it("a call that reaches the tripwire is refused, recorded without its headers or body, and fails the run naming the request", async () => {
    const tripwire = await startAnthropicTripwire();
    try {
      expect(() => failOnAnthropicCalls(tripwire.hits)).not.toThrow(); // no call, no failure
      const res = await fetch(`${tripwire.url}/v1/messages`, { method: "POST", headers: { authorization: "Bearer sk-ant-secret-value" }, body: JSON.stringify({ system: "prompt text" }) });
      expect(res.status).toBe(403);
      expect(() => failOnAnthropicCalls(tripwire.hits)).toThrow(/tried to reach the Anthropic API 1 time[\s\S]*POST \/v1\/messages/);
      let message = "";
      try {
        failOnAnthropicCalls(tripwire.hits);
      } catch (e) {
        message = (e as Error).message;
      }
      expect(message).not.toContain("sk-ant-secret-value");
      expect(message).not.toContain("prompt text");
    } finally {
      await tripwire.close();
    }
  });

  it("an ApiBrain with no endpoint of its own would go to the tripwire, which is how a test that forgot its fake gets caught", async () => {
    const tripwire = await startAnthropicTripwire();
    try {
      const brain = new ApiBrain({ apiKey: "sk-ant-test-0123456789abcdef", baseUrl: anthropicBaseUrl({ ARGUS_ANTHROPIC_URL: tripwire.url }), skillsDir: join(import.meta.dirname, "../../../../.claude/skills"), spentUsd: () => 0 });
      const e = await brain.run("judge", { prompt: "p" }).catch((x) => x);
      expect(e).toMatchObject({ kind: "failed", backend: "api", totalCostUsd: 0 }); // a 403 is a rejected request
      expect(tripwire.hits).toEqual(["POST /v1/messages"]);
    } finally {
      await tripwire.close();
    }
  });

  it("the teardown runs every step even when an earlier one fails, so a leaked claude never hides a call that reached the Anthropic tripwire", async () => {
    const ran: string[] = [];
    await expect(
      runAll([
        () => {
          ran.push("claude");
          throw new Error("real claude was started");
        },
        async () => void ran.push("leaked fakes"),
        () => {
          ran.push("anthropic");
          throw new Error("api was reached");
        },
      ]),
    ).rejects.toThrow("real claude was started"); // the first failure is the one reported
    expect(ran).toEqual(["claude", "leaked fakes", "anthropic"]);
    await expect(runAll([() => {}, async () => {}])).resolves.toBeUndefined();
  });

  it("the run fails when it leaves a temp entry behind, and the entry is removed", () => {
    const root = tempDir("argus-test-run-");
    mkdirSync(join(root, "update-check"));
    expect(() => sweepTempRoot(root)).not.toThrow(); // a tool's own cache alone is not a leak
    const leaky = tempDir("argus-test-run-");
    mkdirSync(join(leaky, "argus-leftover-abc"));
    expect(() => sweepTempRoot(leaky)).toThrow(/left 1 temp entry behind[\s\S]*argus-leftover-abc/);
    expect(existsSync(leaky)).toBe(false);
  });
});
