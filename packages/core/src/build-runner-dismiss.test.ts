import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { buildHomeFor, buildLogPathFor, runNextBuild } from "./build-runner.ts";
import { cleanupBuild, cleanupPlan, cleanupRefusal } from "./cleanup-build.ts";
import { TEST_TOKEN, makeHarness, type Harness } from "./testing/build-harness.ts";
import { untilExists } from "./testing/wait.ts";

// Dismissing a `building` Proposal stops its Build: no deploy and no repo creation after the dismissal, the run closed as `aborted`.
// Fakes only (fake claude, gh, wrangler, podman; a fake Cloudflare behind `options.fetch`): nothing real is created or deleted.

/** Dismisses the Proposal from inside the n-th request the runner makes to the (fake) Cloudflare API: the Operator's click landing at that moment. */
function dismissOnCloudflareCall(h: Harness, proposalId: number, nth: number): void {
  const inner = h.options.fetch!;
  let n = 0;
  h.options.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    if (new URL(String(input)).hostname === "api.cloudflare.com" && ++n === nth) h.store.transition(proposalId, "dismissed", "operator", "not wanted");
    return inner(input, init);
  }) as typeof fetch;
}

/** Dismisses the Proposal from inside the first request the runner makes to the (fake) preview: the click landing after `wrangler deploy`. */
function dismissOnPreviewFetch(h: Harness, proposalId: number): void {
  const inner = h.options.fetch!;
  let done = false;
  h.options.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    if (new URL(String(input)).hostname !== "api.cloudflare.com" && !done) {
      done = true;
      h.store.transition(proposalId, "dismissed", "operator", "not wanted");
    }
    return inner(input, init);
  }) as typeof fetch;
}

/** Fails fast (and loudly) where a Build that does not stop would otherwise hang the test. */
async function within<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what}: still running after ${ms} ms`)), ms);
  });
  try {
    return await Promise.race([promise, late]);
  } finally {
    clearTimeout(timer);
  }
}

const visible = (h: Harness, id: number) => [...h.logs, readFileSync(buildLogPathFor(h.dataDir, id), "utf8"), ...h.store.historyFor(id).map((r) => r.reason)].join("\n");

const WAITING = { claudeEnv: { FAKE_CLAUDE_EFFECT: "wait-release,commit" } };

describe("dismissing a Proposal stops its running Build", { timeout: 60_000 }, () => {
  let current: Harness | undefined;
  const start = (opts?: Parameters<typeof makeHarness>[0]): Harness => (current = makeHarness(opts));
  afterEach(() => {
    // A test that failed with claude still waiting must not leave it running.
    if (current) writeFileSync(current.release, "");
    current = undefined;
  });

  it("while claude runs: claude is stopped, nothing is deployed, the run closes as aborted", async () => {
    const h = start(WAITING);
    h.options.dismissPollMs = 20;
    const p = h.seedApproved("Cat Coin");
    const running = runNextBuild(h.store, h.brain, h.options);
    await untilExists(h.started);
    h.store.transition(p.id, "dismissed", "operator", "changed my mind");
    // The release file is never written: only the dismissal can end this Build.
    expect(await within(running, 15_000, "the dismissed Build")).toEqual({ proposalId: p.id, result: "abandoned" });
    expect(h.store.getProposal(p.id)).toMatchObject({ status: "dismissed", previewUrl: null, brainRunInFlightSince: null });
    expect(h.store.brainRunsFor(p.id)).toMatchObject([{ exitStatus: "aborted" }]);
    expect(h.deployCalls()).toEqual([]);
    expect(h.calls(h.wranglerLog)).toEqual([]);
    expect(h.containers()).toEqual([]);
    expect(existsSync(buildHomeFor(h.dataDir, p.id))).toBe(false);
    expect(visible(h, p.id)).toMatch(/dismissed/i);
  });

  it("before the repo is created: no clone, no gh repo create, no claude", async () => {
    const h = start();
    const p = h.seedApproved("Cat Coin");
    dismissOnCloudflareCall(h, p.id, 1); // the Worker-name check that opens setup
    expect(await within(runNextBuild(h.store, h.brain, h.options), 15_000, "the dismissed Build")).toEqual({ proposalId: p.id, result: "abandoned" });
    expect(h.calls(h.ghLog)).toEqual([]);
    expect(h.calls(h.claudeLog)).toEqual([]);
    expect(existsSync(h.repoDir(p.slug))).toBe(false);
    expect(h.deployCalls()).toEqual([]);
    expect(h.store.getProposal(p.id)).toMatchObject({ status: "dismissed", buildRepo: null, workerDeployed: false });
    expect(h.store.brainRunsFor(p.id)).toMatchObject([{ exitStatus: "aborted" }]);
  });

  it("just before the deploy: the bundle was built, wrangler deploy never runs, and Clean up build then works on the repo and checkout", async () => {
    const h = start();
    const p = h.seedApproved("Cat Coin");
    dismissOnCloudflareCall(h, p.id, 2); // the Worker-name check right before `wrangler deploy`
    expect(await within(runNextBuild(h.store, h.brain, h.options), 30_000, "the dismissed Build")).toEqual({ proposalId: p.id, result: "abandoned" });
    expect(h.deployCalls()).toEqual([]);
    expect(h.store.getProposal(p.id)).toMatchObject({ status: "dismissed", previewUrl: null, workerDeployed: false });
    expect(h.store.brainRunsFor(p.id)).toMatchObject([{ exitStatus: "aborted", totalCostUsd: 0.0123 }]);
    // What the Build created before it stopped is what Clean up build works on: the run no longer blocks it.
    const after = h.store.getProposal(p.id)!;
    expect(h.calls(h.ghLog).map((c) => c.argv.slice(0, 3))).toEqual([["repo", "create", p.slug]]);
    expect(cleanupRefusal(h.store, after, h.buildRoot)).toBeNull();
    expect(cleanupPlan(after, h.buildRoot)).toMatchObject({ worker: { found: false }, repo: { name: `fake-owner/${p.slug}`, found: true }, directory: { found: true } });
    // And it does work, on an injected GitHub: the recorded repo is deleted; no Worker was deployed, so none is touched.
    const asked: string[] = [];
    const github = (async (url: string | URL | Request, init?: RequestInit) => {
      asked.push(`${init?.method ?? "GET"} ${String(url)}`);
      return init?.method === "DELETE" ? new Response(null, { status: 204 }) : Response.json({ full_name: `fake-owner/${p.slug}`, private: true });
    }) as typeof fetch;
    const run = await cleanupBuild(after, { buildRoot: h.buildRoot, env: {}, githubToken: () => "gh-sentinel", fetch: github });
    expect(run.results.map((r) => [r.artifact, r.outcome])).toEqual([["worker", "skipped"], ["repo", "deleted"], ["directory", "skipped"]]);
    expect(asked).toEqual([`GET https://api.github.com/repos/fake-owner/${p.slug}`, `DELETE https://api.github.com/repos/fake-owner/${p.slug}`]);
  });

  it("during the preview check, after wrangler deploy: the run closes as aborted, the stop is noted and the Worker is a leftover", async () => {
    const h = start();
    const p = h.seedApproved("Cat Coin");
    dismissOnPreviewFetch(h, p.id);
    expect(await within(runNextBuild(h.store, h.brain, h.options), 30_000, "the dismissed Build")).toEqual({ proposalId: p.id, result: "abandoned" });
    expect(h.deployCalls()).toHaveLength(1);
    expect(h.store.getProposal(p.id)).toMatchObject({ status: "dismissed", previewUrl: null, workerDeployed: true, brainRunInFlightSince: null });
    expect(h.store.brainRunsFor(p.id)).toMatchObject([{ exitStatus: "aborted" }]);
    expect(visible(h, p.id)).toMatch(/no longer building \(dismissed meanwhile\)/);
    // The deployed Worker is what Clean up build removes: the closed run no longer blocks it.
    const after = h.store.getProposal(p.id)!;
    expect(cleanupPlan(after, h.buildRoot).worker).toEqual({ name: p.slug, found: true });
    expect(cleanupRefusal(h.store, after, h.buildRoot)).toBeNull();
  });

  it("Clean up build is refused until the Build has stopped, then allowed", async () => {
    const h = start(WAITING);
    h.options.dismissPollMs = 20;
    const p = h.seedApproved("Cat Coin");
    const running = runNextBuild(h.store, h.brain, h.options);
    await untilExists(h.started);
    h.store.transition(p.id, "dismissed", "operator", "changed my mind");
    expect(cleanupRefusal(h.store, h.store.getProposal(p.id)!, h.buildRoot)).toMatch(/Build is still running/);
    await within(running, 15_000, "the dismissed Build");
    expect(cleanupRefusal(h.store, h.store.getProposal(p.id)!, h.buildRoot)).toBeNull();
  });

  it("a poll that cannot read the status does not stop a Build that is still wanted", async () => {
    const h = start(WAITING);
    h.options.dismissPollMs = 20;
    const p = h.seedApproved("Cat Coin");
    const running = runNextBuild(h.store, h.brain, h.options);
    await untilExists(h.started);
    const real = h.store.getProposal.bind(h.store);
    h.store.getProposal = () => {
      throw new Error("database is locked");
    };
    await new Promise((r) => setTimeout(r, 100));
    h.store.getProposal = real;
    writeFileSync(h.release, "");
    expect(await within(running, 30_000, "the Build")).toEqual({ proposalId: p.id, result: "built" });
    expect(h.store.getProposal(p.id)!.status).toBe("built");
  });

  it("writes no credential to the Build log, the history or the worker log", async () => {
    const h = start();
    const p = h.seedApproved("Cat Coin");
    dismissOnCloudflareCall(h, p.id, 2);
    await within(runNextBuild(h.store, h.brain, h.options), 30_000, "the dismissed Build");
    const text = visible(h, p.id);
    for (const secret of ["cf-secret", "gh-secret", "sk-secret", TEST_TOKEN]) expect(text).not.toContain(secret);
  });
});
