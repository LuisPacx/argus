import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, sep } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { runNextBuild } from "./build-runner.ts";
import { makeHarness, vcs, type Harness } from "./testing/build-harness.ts";
import { untilExists } from "./testing/wait.ts";

/** Runs one Build and returns the Proposal after, its last status reason, and what the fakes saw. */
async function build(h: Harness, name = "Cat Coin") {
  const p = h.seedApproved(name);
  const outcome = await runNextBuild(h.store, h.brain, h.options);
  const after = h.store.getProposal(p.id)!;
  const reason = h.store.historyFor(p.id).at(-1)!.reason;
  return { p, outcome, after, reason, deploys: h.deployCalls() };
}

const marker = (label: string) => {
  const path = join(tmpdir(), `argus-${label}-${process.pid}-${Math.random().toString(36).slice(2)}`);
  rmSync(path, { force: true });
  return path;
};
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

describe("deploy uses a wrangler config that argus wrote", () => {
  it("ignores everything in the agent's wrangler.jsonc: name, main, account, routes, assets, bindings and a build command hidden behind a JSON escape", async () => {
    const pwned = marker("wrangler");
    const h = makeHarness({ claudeEnv: { FAKE_CLAUDE_EFFECT: "tamper-wrangler-config,commit", FAKE_CLAUDE_MARKER: pwned } });
    const r = await build(h);
    expect(r.after.status).toBe("built");

    // The agent's file really was committed, hostile content and all.
    expect(readFileSync(join(h.repoDir("cat-coin"), "wrangler.jsonc"), "utf8")).toContain("attacker");

    const [deploy] = r.deploys;
    const config = deploy!.argv[deploy!.argv.indexOf("--config") + 1] as string;
    expect(isAbsolute(config)).toBe(true);
    expect(config.startsWith(realpathSync(h.repoDir("cat-coin")) + sep)).toBe(false);
    // The deployed Worker is the bundle argus made in its own scratch directory, not anything in the agent's repo.
    const deployed = JSON.parse(deploy!.configText as string) as { name: string; main: string; compatibility_date: string };
    expect(deployed).toEqual({ name: "cat-coin", main: `${dirname(config)}/dist/index.js`, compatibility_date: "2026-11-01" });
    expect(deployed.main.startsWith(realpathSync(h.repoDir("cat-coin")) + sep)).toBe(false);
    expect(deploy!.argv.slice(0, 3)).toEqual(["deploy", "--name", "cat-coin"]);
    expect(existsSync(pwned)).toBe(false);
    // The config is scratch: it is gone once the Build is.
    expect(existsSync(config)).toBe(false);
  });

  it("refuses to deploy when the entry point is a symlink out of the repo", async () => {
    const h = makeHarness({ claudeEnv: { FAKE_CLAUDE_EFFECT: "symlink-main,commit" } });
    const r = await build(h);
    expect(r.after.status).toBe("build-failed");
    expect(r.reason).toContain("src/index.ts");
    expect(r.deploys).toEqual([]);
  });
});

describe("wrangler never runs where the agent's files are", () => {
  it("runs in argus's own scratch directory with an argus-owned empty --env-file, so a hostile .env, .env.local or .dev.vars in the repo is never loaded", async () => {
    const h = makeHarness({ claudeEnv: { FAKE_CLAUDE_EFFECT: "commit,plant-env" } });
    const r = await build(h);
    expect(r.after.status).toBe("built");
    const repo = realpathSync(h.repoDir("cat-coin"));
    // The hostile files really are in the repo (ignored by the template, so the clean-tree check passes them).
    expect(readFileSync(join(repo, ".env"), "utf8")).toContain("CLOUDFLARE_API_BASE_URL");

    const [deploy] = r.deploys;
    const cwd = deploy!.cwd as string; // the scratch directory is gone by now, so no realpath
    const config = deploy!.argv[deploy!.argv.indexOf("--config") + 1] as string;
    expect(cwd === repo || cwd.startsWith(repo + sep)).toBe(false);
    expect(cwd).toBe(dirname(config));
    expect(deploy!.cwdEnvFiles).toEqual([]);
    expect(deploy!.envFiles).toHaveLength(1);
    const envFile = deploy!.envFiles[0] as string;
    expect(isAbsolute(envFile)).toBe(true);
    expect(envFile.startsWith(repo + sep)).toBe(false);
    expect(deploy!.envFileTexts).toEqual([""]);
    expect(Object.keys(deploy!.cf)).toEqual(["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"]);
  });
});

describe("runner git ignores every config the agent or the machine could supply", () => {
  it("never runs a filter, credential helper or ssh command from .git/config, and pushes to the real origin despite pushurl and insteadOf", async () => {
    const pwned = marker("gitconfig");
    const h = makeHarness({ claudeEnv: { FAKE_CLAUDE_EFFECT: "commit,plant-git-config", FAKE_CLAUDE_MARKER: pwned } });
    const r = await build(h);
    expect(r.after.status).toBe("built");
    expect(existsSync(pwned)).toBe(false);
    expect(existsSync(`${pwned}-evil-pushurl.git`)).toBe(false);
    expect(existsSync(`${pwned}-evil`)).toBe(false);
    // The pushed commit is the built one (the .gitattributes commit sits below it).
    expect(vcs(join(h.remotes, "cat-coin.git"), "rev-parse", "main")).toBe(vcs(h.repoDir("cat-coin"), "rev-parse", "HEAD"));
  });

  it("does not read the machine's global git config either", async () => {
    const h = makeHarness();
    writeFileSync(join(h.root, ".gitconfig"), `[url "${h.root}/nowhere/"]\n\tinsteadOf = ${h.remotes}/\n`);
    const r = await build(h);
    expect(r.after.status).toBe("built");
    expect(vcs(join(h.remotes, "cat-coin.git"), "rev-parse", "main")).toBe(vcs(h.repoDir("cat-coin"), "rev-parse", "HEAD"));
  });
});

describe("a command's whole process group is killed on timeout", () => {
  it("a wrangler that hangs after starting a grandchild is killed with it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "argus-wr-"));
    const grandchild = join(dir, "grandchild");
    const started = join(dir, "started");
    const h = makeHarness({ wranglerEnv: { FAKE_WRANGLER_HANG: "1", FAKE_WRANGLER_GRANDCHILD: grandchild, FAKE_WRANGLER_STARTED: started } });
    // The command timeout is a timer here, driven by hand once wrangler says it is up: no guess at how long node takes to start.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const p = h.seedApproved("Cat Coin");
      const running = runNextBuild(h.store, h.brain, h.options);
      await untilExists(started);
      vi.advanceTimersByTime(h.options.commandTimeoutMs ?? 10 * 60_000);
      await running;
      const after = h.store.getProposal(p.id)!;
      expect(after.status).toBe("build-failed");
      expect(h.store.historyFor(p.id).at(-1)!.reason).toContain("wrangler deploy failed");
    } finally {
      vi.useRealTimers();
    }
    await untilDead(Number(readFileSync(grandchild, "utf8")));
  });
});

describe("every normal exit reaps the command's process group", () => {
  it("a process wrangler leaves running after a successful deploy is killed", async () => {
    const straggler = marker("straggler");
    const h = makeHarness({ wranglerEnv: { FAKE_WRANGLER_STRAGGLER: straggler } });
    const r = await build(h);
    expect(r.after.status).toBe("built");
    await untilDead(Number(readFileSync(straggler, "utf8")));
  });

  it("a process claude leaves running after a normal exit is killed before the runner checks the repo", async () => {
    const straggler = marker("claude-straggler");
    const h = makeHarness({ claudeEnv: { FAKE_CLAUDE_MODE: "success-straggler", FAKE_CLAUDE_GRANDCHILD: straggler } });
    const r = await build(h);
    expect(r.after.status).toBe("built");
    await untilDead(Number(readFileSync(straggler, "utf8")));
  });
});

describe("the build run stays open until the Build is over", () => {
  it("is still in flight, with the claude spend already recorded, while wrangler deploys; then closed as the Proposal turns built", async () => {
    const dir = mkdtempSync(join(tmpdir(), "argus-wr-"));
    const started = join(dir, "started");
    const release = join(dir, "release");
    const h = makeHarness({ wranglerEnv: { FAKE_WRANGLER_STARTED: started, FAKE_WRANGLER_RELEASE: release } });
    const p = h.seedApproved("Cat Coin");
    const running = runNextBuild(h.store, h.brain, h.options);
    await untilExists(started);

    expect(h.store.getProposal(p.id)).toMatchObject({ status: "building" });
    expect(h.store.getProposal(p.id)!.brainRunInFlightSince).not.toBeNull();
    expect(h.store.brainRunsFor(p.id)).toMatchObject([{ exitStatus: "in-flight", totalCostUsd: 0.0123, sessionId: "5e55a0a0-0000-4000-8000-000000000001" }]);

    writeFileSync(release, "");
    expect(await running).toEqual({ proposalId: p.id, result: "built" });
    expect(h.store.getProposal(p.id)).toMatchObject({ status: "built", brainRunInFlightSince: null });
    expect(h.store.brainRunsFor(p.id)).toMatchObject([{ exitStatus: "success", totalCostUsd: 0.0123 }]);
  });

  it("the startup sweep also frees a building Proposal that has no open build run at all", () => {
    const h = makeHarness();
    const p = h.seedApproved("Cat Coin");
    h.store.transition(p.id, "building", "build");
    const run = h.store.startBrainRun({ proposalId: p.id, task: "build", backend: "claude-code", model: "sonnet" });
    h.store.finishBrainRun(run, { sessionId: null, totalCostUsd: 0.5, exitStatus: "success" }); // what the old runner left behind mid-deploy

    expect(h.store.interruptStaleBrainRuns((task) => h.brain.staleAfterMs(task))).toBe(1);
    expect(h.store.getProposal(p.id)).toMatchObject({ status: "build-failed", agentCostUsd: 0.5 });
    expect(h.store.historyFor(p.id).at(-1)).toMatchObject({ to: "build-failed", actor: "build" });
    expect(h.store.historyFor(p.id).at(-1)!.reason).toContain("no open run");
  });

  it("the sweep counts a Build's age from its last heartbeat, so a live Build that spends hours after claude is not failed", () => {
    const h = makeHarness();
    const p = h.seedApproved("Cat Coin");
    h.store.transition(p.id, "building", "build");
    const run = h.store.startBrainRun({ proposalId: p.id, task: "build", backend: "claude-code", model: "sonnet" });
    const t0 = Date.now();
    const stale = (task: string) => h.brain.staleAfterMs(task); // the build cap plus the grace: 4 h 5 min
    // claude used its whole 4 h; the deploy, crawl and push now run on a worker that is still alive and beating.
    h.store.touchBrainRun(run, new Date(t0 + 3 * 60 * 60_000 + 55 * 60_000));
    expect(h.store.interruptStaleBrainRuns(stale, new Date(t0 + 4 * 60 * 60_000 + 30 * 60_000))).toBe(0);
    expect(h.store.getProposal(p.id)!.status).toBe("building");
    // A worker that died stops beating, and the run is stale once the window has passed since its last beat.
    expect(h.store.interruptStaleBrainRuns(stale, new Date(t0 + 8 * 60 * 60_000 + 5 * 60_000))).toBe(1);
    expect(h.store.getProposal(p.id)!.status).toBe("build-failed");
  });

  it("a running Build beats while it deploys", async () => {
    const dir = mkdtempSync(join(tmpdir(), "argus-wr-"));
    const started = join(dir, "started");
    const release = join(dir, "release");
    const h = makeHarness({ wranglerEnv: { FAKE_WRANGLER_STARTED: started, FAKE_WRANGLER_RELEASE: release } });
    h.options.heartbeatMs = 10;
    const p = h.seedApproved("Cat Coin");
    const running = runNextBuild(h.store, h.brain, h.options);
    await untilExists(started);
    const beat = () => h.store.brainRunsFor(p.id)[0]!.heartbeatAt;
    const waitFor = async (ok: () => boolean) => {
      for (const end = Date.now() + 20_000; !ok() && Date.now() < end; ) await new Promise((r) => setTimeout(r, 10));
      expect(ok()).toBe(true);
    };
    await waitFor(() => beat() !== null);
    const first = beat();
    await waitFor(() => beat() !== first);
    writeFileSync(release, "");
    expect(await running).toEqual({ proposalId: p.id, result: "built" });
    // Once the run is closed nothing touches it again.
    const last = beat();
    await new Promise((r) => setTimeout(r, 50));
    expect(beat()).toBe(last);
  });

  it("a beat that fails (a busy database) is logged and never thrown out of the timer, so it cannot crash the worker; the Build carries on", async () => {
    const dir = mkdtempSync(join(tmpdir(), "argus-wr-"));
    const started = join(dir, "started");
    const release = join(dir, "release");
    const h = makeHarness({ wranglerEnv: { FAKE_WRANGLER_STARTED: started, FAKE_WRANGLER_RELEASE: release } });
    // The timer's callback is taken out and called by hand, so the test neither waits on a clock nor depends on host load.
    h.options.heartbeatMs = 12_345;
    const real = globalThis.setInterval;
    let beat: (() => void) | undefined;
    const spy = vi.spyOn(globalThis, "setInterval").mockImplementation(((fn: () => void, ms?: number, ...rest: unknown[]) => {
      if (ms === 12_345) beat = fn;
      return real(fn, ms, ...rest);
    }) as typeof setInterval);
    const touch = vi.spyOn(h.store, "touchBrainRun").mockImplementation(() => {
      throw new Error("database is locked");
    });
    try {
      const p = h.seedApproved("Cat Coin");
      const running = runNextBuild(h.store, h.brain, h.options);
      await untilExists(started);
      expect(beat).toBeDefined();
      expect(() => beat!()).not.toThrow();
      expect(touch).toHaveBeenCalledTimes(1);
      expect(h.logs.join("\n")).toContain("database is locked");
      writeFileSync(release, "");
      expect(await running).toEqual({ proposalId: p.id, result: "built" });
    } finally {
      spy.mockRestore();
      touch.mockRestore();
    }
  });

  it("the sweep leaves a building Proposal with a young open run alone", () => {
    const h = makeHarness();
    const p = h.seedApproved("Cat Coin");
    h.store.transition(p.id, "building", "build");
    h.store.startBrainRun({ proposalId: p.id, task: "build", backend: "claude-code", model: "sonnet" });
    expect(h.store.interruptStaleBrainRuns((task) => h.brain.staleAfterMs(task))).toBe(0);
    expect(h.store.getProposal(p.id)!.status).toBe("building");
  });
});

describe("a Worker name already taken in the Cloudflare account is never overwritten", () => {
  it("fails the Build before anything is created or spent when the name is taken", async () => {
    const h = makeHarness({ workers: ["cat-coin"] });
    const r = await build(h);
    expect(r.after.status).toBe("build-failed");
    expect(r.reason).toContain("Worker named cat-coin already exists");
    expect(r.deploys).toEqual([]);
    expect(h.calls(h.claudeLog)).toEqual([]);
    expect(h.calls(h.ghLog)).toEqual([]);
    expect(h.apiCalls[0]).toEqual({ url: "https://api.cloudflare.com/client/v4/accounts/acct/workers/scripts/cat-coin/settings", authorization: "Bearer cf-secret" });
  });

  it("checks again right before deploying: a Worker created during the Build is not overwritten", async () => {
    const h = makeHarness({ claudeEnv: { FAKE_CLAUDE_EFFECT: "wait-release,commit" } });
    const p = h.seedApproved("Cat Coin");
    const running = runNextBuild(h.store, h.brain, h.options);
    await untilExists(h.started);
    h.workers.add("cat-coin");
    writeFileSync(h.release, "");
    expect(await running).toEqual({ proposalId: p.id, result: "build-failed" });
    expect(h.store.historyFor(p.id).at(-1)!.reason).toContain("already exists");
    expect(h.deployCalls()).toEqual([]);
    // The claude run's spend is still on the card.
    expect(h.store.getProposal(p.id)!.agentCostUsd).toBeCloseTo(0.0123);
  });

  it("fails closed when the account cannot be checked", async () => {
    const h = makeHarness({ cloudflareDown: true });
    const r = await build(h);
    expect(r.after.status).toBe("build-failed");
    expect(r.reason).toContain("could not check");
    expect(r.deploys).toEqual([]);
    expect(h.calls(h.claudeLog)).toEqual([]);
  });
});
