import { existsSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildLogPathFor, runNextBuild, runPendingBuilds } from "./build-runner.ts";
import { makeHarness, vcs, type Harness } from "./testing/build-harness.ts";
import { tempDir } from "./testing/temp.ts";
import { untilExists } from "./testing/wait.ts";

// Each test runs whole Builds: git, a container's worth of fake processes, a bundle and a deploy. Under load that is not 5 s.
describe("Build Runner: happy path", { timeout: 60_000 }, () => {
  it("clones the template, creates the repo, runs the build, deploys, and marks the Proposal built with its preview and cost", async () => {
    const h = makeHarness();
    const p = h.seedApproved("Cat Coin");

    const outcome = await runNextBuild(h.store, h.brain, h.options);

    expect(outcome).toEqual({ proposalId: p.id, result: "built" });
    const built = h.store.getProposal(p.id)!;
    expect(built.status).toBe("built");
    expect(built.previewUrl).toBe("https://cat-coin.fake-account.workers.dev");
    // The repo gh reported is recorded, so Clean up build can later delete that one (and only that one).
    expect(built.buildRepo).toBe("fake-owner/cat-coin");
    // approved -> building -> built, all by the build actor, through the lifecycle table.
    expect(h.store.historyFor(p.id).map((e) => [e.from, e.to, e.actor])).toEqual([
      [null, "new", "system"],
      ["new", "shortlisted", "operator"],
      ["shortlisted", "spec-drafted", "system"],
      ["spec-drafted", "approved", "operator"],
      ["approved", "building", "build"],
      ["building", "built", "build"],
    ]);

    // The repo: the template clone with the Spec written in and the Worker renamed to the slug.
    const repo = h.repoDir("cat-coin");
    expect(readFileSync(join(repo, "SPEC.md"), "utf8")).toBe(readFileSync(join(h.dataDir, "proposals", String(p.id), "spec.md"), "utf8"));
    expect(readFileSync(join(repo, "wrangler.jsonc"), "utf8")).toContain('"name": "cat-coin"');
    expect(vcs(repo, "status", "--porcelain")).toBe("");

    // gh made a private repo from the clone; the result was pushed to it.
    const [create] = h.calls(h.ghLog);
    expect(create!.argv).toEqual(["repo", "create", "cat-coin", "--private", "--source", ".", "--remote", "origin"]);
    expect(vcs(join(h.remotes, "cat-coin.git"), "rev-parse", "main")).toBe(vcs(repo, "rev-parse", "HEAD"));

    // wrangler deploys under the slug, with the Cloudflare credentials and nothing the build run saw.
    const [deploy] = h.deployCalls();
    expect(deploy!.argv.slice(0, 3)).toEqual(["deploy", "--name", "cat-coin"]);
    expect(deploy!.argv[3]).toBe("--config");
    // Not the agent's repo: wrangler loads .env files from its cwd (see build-runner-hardening.test.ts).
    expect(deploy!.cwd).not.toBe(repo);
    expect((deploy!.cwd as string).startsWith(realpathSync(repo))).toBe(false);
    expect(deploy!.cf).toEqual({ CLOUDFLARE_API_TOKEN: "cf-secret", CLOUDFLARE_ACCOUNT_ID: "acct" });
    expect(deploy!.keys).not.toContain("ANTHROPIC_API_KEY");

    // The claude run: cwd is the Build repo, scoped tools, no secrets.
    const [claude] = h.calls(h.claudeLog);
    expect(claude!.cwd).toBe(repo);
    expect(claude!.argv.slice(0, 2)).toEqual(["-p", `/implement-spec ${p.id}`]);
    expect(claude!.argv[claude!.argv.indexOf("--permission-mode") + 1]).toBe("acceptEdits");
    expect(claude!.argv[claude!.argv.indexOf("--output-format") + 1]).toBe("stream-json");
    expect(claude!.argv).toContain("--verbose");
    expect(claude!.argv[claude!.argv.indexOf("--max-budget-usd") + 1]).toBe("25");
    expect(claude!.argv[claude!.argv.indexOf("--allowedTools") + 1]!.split(",")).not.toContain("Bash");
    expect(claude!.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(claude!.env.CLOUDFLARE_API_TOKEN).toBeUndefined();

    // Spend: the final result's session and cost are stored, and the card cost includes the Build.
    expect(h.store.brainRunsFor(p.id)).toMatchObject([{ task: "build", exitStatus: "success", sessionId: "5e55a0a0-0000-4000-8000-000000000001", totalCostUsd: 0.0123 }]);
    expect(built.agentCostUsd).toBeCloseTo(0.0123);

    // The stream-json lines were appended to build.log.
    const log = readFileSync(buildLogPathFor(h.dataDir, p.id), "utf8");
    const events = log.split("\n").filter((l) => l.startsWith("{")).map((l) => JSON.parse(l) as { type: string });
    expect(events.map((e) => e.type)).toEqual(["system", "rate_limit_event", "assistant", "result"]);
    expect(existsSync(join(h.buildRoot, "cat-coin"))).toBe(true);
  });

  it("does nothing when no Proposal is approved", async () => {
    const h = makeHarness();
    expect(await runNextBuild(h.store, h.brain, h.options)).toBeUndefined();
    expect(h.calls(h.claudeLog)).toEqual([]);
  });
});

describe("Build Runner: queue", { timeout: 60_000 }, () => {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  it("builds one at a time: a second pass while a Build runs spawns nothing, and the next Build starts after", async () => {
    const h = makeHarness({ claudeEnv: { FAKE_CLAUDE_EFFECT: "wait-release,commit" } });
    const a = h.seedApproved("Alpha Coin");
    await sleep(3);
    const b = h.seedApproved("Beta Coin");

    const first = runNextBuild(h.store, h.brain, h.options);
    await untilExists(h.started);
    // Alpha is building, with its brain run open before the child was spawned.
    expect(h.store.getProposal(a.id)).toMatchObject({ status: "building" });
    expect(h.store.getProposal(a.id)!.brainRunInFlightSince).not.toBeNull();
    expect(h.store.brainRunsFor(a.id)).toMatchObject([{ task: "build", exitStatus: "in-flight" }]);
    expect(await runNextBuild(h.store, h.brain, h.options)).toBeUndefined();
    expect(h.calls(h.claudeLog)).toHaveLength(1);
    expect(h.store.getProposal(b.id)!.status).toBe("approved");

    writeFileSync(h.release, "");
    expect(await first).toEqual({ proposalId: a.id, result: "built" });
    expect(await runNextBuild(h.store, h.brain, h.options)).toEqual({ proposalId: b.id, result: "built" });
    expect(h.calls(h.claudeLog)).toHaveLength(2);
  });

  it("takes Proposals in approval order", async () => {
    const h = makeHarness();
    const x = h.seedApproved("Early Approval");
    await sleep(3);
    const y = h.seedApproved("Late Approval");
    const done: number[] = [];
    h.options.log = (l) => {
      const m = /^\[worker\] build for proposal (\d+): built/.exec(l);
      if (m) done.push(Number(m[1]));
    };
    expect(await runPendingBuilds(h.store, h.brain, h.options)).toBe(2);
    expect(done).toEqual([x.id, y.id]);
  });

  it("a later-created Proposal approved earlier is built first", async () => {
    const h = makeHarness();
    // Create both, shortlist both, then approve the second Proposal before the first.
    const mk = (name: string, ticker: string) => h.store.createProposal({ narrativeSummary: "n", techOneLiner: "t", whyNow: "w", name, ticker, description: "d", evidenceLinks: [] });
    const p1 = mk("One Coin", "ONE");
    const p2 = mk("Two Coin", "TWO");
    const { approve } = await import("./lifecycle.ts");
    const { specPathFor } = await import("./spec-drafting.ts");
    const { mkdirSync } = await import("node:fs");
    const { dirname } = await import("node:path");
    for (const p of [p1, p2]) {
      h.store.transition(p.id, "shortlisted", "operator");
      const path = specPathFor(h.dataDir, p.id);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, "# Spec\n");
      h.store.completeSpec(p.id, { path, hash: "h" });
    }
    approve(h.store, p2.id);
    await sleep(3);
    approve(h.store, p1.id);
    expect(await runNextBuild(h.store, h.brain, h.options)).toEqual({ proposalId: p2.id, result: "built" });
  });
});

describe("Build Runner: dry-run", { timeout: 30_000 }, () => {
  it("logs the clone, repo-create, spawn and deploy commands and runs none of them", async () => {
    const h = makeHarness({ dryRun: true });
    const p = h.seedApproved("Cat Coin");

    const outcome = await runNextBuild(h.store, h.brain, h.options);

    expect(outcome).toEqual({ proposalId: p.id, result: "dry-run" });
    const text = h.logs.join("\n");
    expect(text).toContain(`dry-run: git clone --origin template ${h.options.templateRepo} ${h.repoDir("cat-coin")}`);
    expect(text).toMatch(/dry-run: \S*fake-gh\.mjs repo create cat-coin --private --source \. --remote origin/);
    expect(text).toMatch(/dry-run: claude \(cwd .*cat-coin\) -p "\/implement-spec \d+" --output-format stream-json --model sonnet --max-budget-usd 25 /);
    expect(text).toContain("--permission-mode acceptEdits");
    // The bundle is a container step now (its own podman line, below); the deploy stays a host wrangler call.
    expect(text).toMatch(/dry-run: \S*fake-wrangler\.mjs deploy --name cat-coin --config \S*wrangler-deploy\.jsonc/);
    expect(text).toMatch(/dry-run: \S*fake-podman\.mjs run .*wrangler deploy --name cat-coin --config \S*wrangler\.jsonc .*--dry-run/);
    // Nothing of podman ran either, not even the preflight.
    expect(h.podmanCalls()).toEqual([]);
    // Nothing ran, nothing was recorded, nothing changed.
    expect(existsSync(h.repoDir("cat-coin"))).toBe(false);
    expect(h.calls(h.claudeLog)).toEqual([]);
    expect(h.calls(h.ghLog)).toEqual([]);
    expect(h.deployCalls()).toEqual([]);
    expect(h.store.brainRunsFor(p.id)).toEqual([]);
    expect(h.store.getProposal(p.id)!.status).toBe("approved");
    expect(existsSync(buildLogPathFor(h.dataDir, p.id))).toBe(false);
  });

  it("a pass over several approved Proposals reports the next Build once instead of looping", async () => {
    const h = makeHarness({ dryRun: true });
    h.seedApproved("Alpha Coin");
    h.seedApproved("Beta Coin");
    expect(await runPendingBuilds(h.store, h.brain, h.options)).toBe(0);
    expect(h.logs.filter((l) => l.includes("repo create"))).toHaveLength(1);
  });
});

describe("Build Runner: temp dirs", { timeout: 60_000 }, () => {
  /**
   * Runs one Build with the temp dir pointed at a fresh directory and returns what the runner left in it besides the
   * harness's own root: the seal (and the env and config files inside it) must be gone on every terminal path.
   */
  async function leftBehind(opts: Parameters<typeof makeHarness>[0], run: (h: Harness) => Promise<{ result: string } | undefined>) {
    const tmp = tempDir("argus-seal-check-");
    const saved = process.env.TMPDIR;
    process.env.TMPDIR = tmp;
    try {
      const h = makeHarness(opts);
      h.seedApproved("Cat Coin");
      const outcome = await run(h);
      const harnessRoot = h.root.slice(tmp.length + 1).split("/")[0];
      return { outcome, left: readdirSync(tmp).filter((n) => n !== harnessRoot) };
    } finally {
      if (saved === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = saved;
    }
  }
  const once = (h: Harness) => runNextBuild(h.store, h.brain, h.options);

  it("removes the seal when the Build succeeds", async () => {
    const { outcome, left } = await leftBehind({}, once);
    expect(outcome?.result).toBe("built");
    expect(left).toEqual([]);
  });

  it("removes the seal when the Build fails after the seal was made", async () => {
    const { outcome, left } = await leftBehind({ claudeEnv: { FAKE_CLAUDE_EFFECT: "" } }, once); // nothing committed: rejected once the seal exists
    expect(outcome?.result).toBe("build-failed");
    expect(left).toEqual([]);
  });

  it("removes the seal when a command times out", async () => {
    const started = join(tempDir("argus-hang-"), "started");
    const { outcome, left } = await leftBehind({ wranglerEnv: { FAKE_WRANGLER_HANG: "1", FAKE_WRANGLER_STARTED: started } }, (h) => {
      h.options.commandTimeoutMs = 1_500;
      return once(h);
    });
    expect(existsSync(started)).toBe(true); // it got as far as the bundle step, after the seal was made
    expect(outcome?.result).toBe("build-failed");
    expect(left).toEqual([]);
  });

  it("removes the seal when the worker shuts down mid-Build", async () => {
    const started = join(tempDir("argus-hang-"), "started");
    const ac = new AbortController();
    const { outcome, left } = await leftBehind({ wranglerEnv: { FAKE_WRANGLER_HANG: "1", FAKE_WRANGLER_STARTED: started } }, async (h) => {
      const running = runNextBuild(h.store, h.brain, h.options, ac.signal);
      await untilExists(started);
      ac.abort();
      return running;
    });
    expect(outcome?.result).not.toBe("built");
    expect(left).toEqual([]);
  });
});
