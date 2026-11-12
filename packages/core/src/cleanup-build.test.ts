import { existsSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { cleanupBuild, cleanupLine, cleanupPlan, cleanupRefusal, parseGithubRepo, runPendingCleanups, type CleanupOptions } from "./cleanup-build.ts";
import { Datastore, type Proposal } from "./datastore.ts";
import { requeueLeftovers } from "./lifecycle.ts";
import { applyPending } from "./testing/apply.ts";
import { tempDir } from "./testing/temp.ts";

// Every test here uses a temp build root and an injected fetch: no real Cloudflare, GitHub, gh, wrangler or home directory is touched.
const MINT = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";
const CF_TOKEN = "cf-sentinel-token-9f3a";
const GH_TOKEN = "gh-sentinel-token-71bc";
const input = { narrativeSummary: "n", techOneLiner: "t", whyNow: "w", name: "Download Bar Blues", ticker: "DBB", description: "d", evidenceLinks: [] };

type Status = "dismissed" | "build-failed" | "built" | "launched" | "closed-after-launch" | "dismissed-after-launch" | "approved" | "needs-human";
function seed(ds: Datastore, status: Status): Proposal {
  const p = ds.createProposal({ ...input, name: `Bar ${ds.listProposals().length}` });
  ds.transition(p.id, "shortlisted", "operator");
  ds.transition(p.id, "spec-drafted", "system");
  if (status === "approved" || status === "needs-human") ds.transition(p.id, "approved", "operator");
  if (status === "needs-human") ds.transition(p.id, "needs-human", "build");
  if (status === "dismissed") ds.transition(p.id, "dismissed", "operator", "meh");
  if (["build-failed", "built", "launched", "closed-after-launch", "dismissed-after-launch"].includes(status)) {
    ds.transition(p.id, "approved", "operator");
    ds.transition(p.id, "building", "build");
  }
  if (status === "build-failed") ds.transition(p.id, "build-failed", "build");
  if (["built", "launched", "closed-after-launch", "dismissed-after-launch"].includes(status)) ds.completeBuild(p.id, { previewUrl: "https://x.workers.dev" });
  if (["launched", "closed-after-launch", "dismissed-after-launch"].includes(status)) ds.markLaunched(p.id, MINT.slice(0, -1) + "123456789abcdefghijk"[p.id % 20]);
  if (status === "closed-after-launch") ds.transition(p.id, "closed", "operator");
  if (status === "dismissed-after-launch") ds.transition(p.id, "dismissed", "operator", "done");
  return ds.getProposal(p.id)!;
}

/** A Build checkout: `.git/config` with the `template` remote the Build clones from and an `origin` at `originUrl` (none when null). */
function checkout(root: string, slug: string, originUrl: string | null): string {
  const dir = join(root, slug);
  mkdirSync(join(dir, ".git"), { recursive: true });
  const origin = originUrl === null ? "" : `[remote "origin"]\n\turl = ${originUrl}\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n`;
  writeFileSync(join(dir, ".git", "config"), `[core]\n\tbare = false\n[remote "template"]\n\turl = /somewhere/argus-build-template\n${origin}`);
  writeFileSync(join(dir, "SPEC.md"), "spec\n");
  return dir;
}

interface Call {
  method: string;
  url: string;
  auth: string | null;
}
type Handler = (c: Call) => Response | undefined;
/** A fetch that answers from `routes` (first handler to return a Response wins) and records what it was asked. */
function fakeFetch(routes: Handler[]) {
  const calls: Call[] = [];
  const f = (async (url: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    const call = { method: init?.method ?? "GET", url: String(url), auth: headers.get("authorization") };
    calls.push(call);
    for (const r of routes) {
      const res = r(call);
      if (res) return res;
    }
    return new Response("{}", { status: 500 });
  }) as typeof fetch;
  return { fetch: f, calls };
}
const json = (status: number, body: unknown = {}) => new Response(JSON.stringify(body), { status });
const cfWorker = (slug: string, answer: () => Response): Handler => (c) => (c.url.includes("api.cloudflare.com") && c.url.endsWith(`/workers/scripts/${slug}`) && c.method === "DELETE" ? answer() : undefined);
const ghRepo = (full: string, get: () => Response, del: () => Response): Handler => (c) => {
  if (c.url === `https://api.github.com/repos/${full}`) return c.method === "DELETE" ? del() : get();
  return undefined;
};
const ghUser = (login: string): Handler => (c) => (c.url === "https://api.github.com/user" ? json(200, { login }) : undefined);
const privateRepo = (full: string) => json(200, { full_name: full, private: true });

function opts(buildRoot: string, over: Partial<CleanupOptions> = {}): CleanupOptions {
  return { buildRoot, env: { CLOUDFLARE_ACCOUNT_ID: "acct1", CLOUDFLARE_API_TOKEN: CF_TOKEN }, githubToken: () => GH_TOKEN, ...over };
}

/** A dismissed Proposal with all three artifacts, recorded the way a new Build records them. */
function built(ds: Datastore, root: string, over: { repo?: string | null; deployed?: boolean; origin?: string | null } = {}) {
  const p = seed(ds, "dismissed");
  if (over.deployed !== false) ds.markWorkerDeployed(p.id);
  const repo = over.repo === undefined ? `luis/${p.slug}` : over.repo;
  if (repo) ds.recordBuildRepo(p.id, repo);
  checkout(root, p.slug, over.origin === undefined ? `https://github.com/luis/${p.slug}.git` : over.origin);
  return ds.getProposal(p.id)!;
}

const happy = (p: Proposal): Handler[] => [
  cfWorker(p.slug, () => json(200, { success: true })),
  ghRepo(`luis/${p.slug}`, () => privateRepo(`luis/${p.slug}`), () => new Response(null, { status: 204 })),
];

describe("who may be cleaned", () => {
  it("allows dismissed, closed and build-failed Proposals that have an artifact", () => {
    const ds = Datastore.open(":memory:");
    const root = tempDir("argus-clean-");
    for (const status of ["dismissed", "build-failed"] as const) {
      const p = seed(ds, status);
      expect(cleanupRefusal(ds, p, root), status).toMatch(/Nothing to clean up/);
      ds.markWorkerDeployed(p.id);
      expect(cleanupRefusal(ds, ds.getProposal(p.id)!, root), status).toBeNull();
    }
    const c = seed(ds, "dismissed");
    checkout(root, c.slug, null);
    expect(cleanupRefusal(ds, c, root)).toBeNull();
  });

  it("refuses every other status, launched above all", () => {
    const ds = Datastore.open(":memory:");
    const root = tempDir("argus-clean-");
    for (const status of ["approved", "needs-human", "built", "launched"] as const) {
      const p = seed(ds, status);
      ds.markWorkerDeployed(p.id);
      checkout(root, p.slug, `https://github.com/luis/${p.slug}`);
      expect(cleanupRefusal(ds, ds.getProposal(p.id)!, root), status).toMatch(/never done for a launched|needs a dismissed/);
    }
  });

  it("refuses a closed or dismissed Proposal that had been launched", () => {
    const ds = Datastore.open(":memory:");
    const root = tempDir("argus-clean-");
    for (const status of ["closed-after-launch", "dismissed-after-launch"] as const) {
      const p = seed(ds, status);
      ds.markWorkerDeployed(p.id);
      checkout(root, p.slug, `https://github.com/luis/${p.slug}`);
      const now = ds.getProposal(p.id)!;
      expect(["closed", "dismissed"]).toContain(now.status);
      expect(cleanupRefusal(ds, now, root), status).toMatch(/launched/);
    }
  });
});

describe("the worker's cleanup pass", () => {
  it("deletes the Worker, the repo and the directory through the injected fetch, and records one history row each", async () => {
    const ds = Datastore.open(":memory:");
    const root = tempDir("argus-clean-");
    const p = built(ds, root);
    const { fetch, calls } = fakeFetch(happy(p));
    ds.enqueueCommand(p.id, "cleanup-build");
    expect(await runPendingCleanups(ds, opts(root, { fetch }))).toBe(1);

    expect(calls).toEqual([
      { method: "DELETE", url: `https://api.cloudflare.com/client/v4/accounts/acct1/workers/scripts/${p.slug}`, auth: `Bearer ${CF_TOKEN}` },
      { method: "GET", url: `https://api.github.com/repos/luis/${p.slug}`, auth: `Bearer ${GH_TOKEN}` },
      { method: "DELETE", url: `https://api.github.com/repos/luis/${p.slug}`, auth: `Bearer ${GH_TOKEN}` },
    ]);
    expect(existsSync(join(root, p.slug))).toBe(false);
    const after = ds.getProposal(p.id)!;
    expect(after).toMatchObject({ status: "dismissed", buildCleaned: true });
    const rows = ds.historyFor(p.id).filter((h) => h.reason.startsWith("Clean up:"));
    expect(rows.map((r) => r.reason)).toEqual([
      `Clean up: Worker ${p.slug} deleted`,
      `Clean up: repo luis/${p.slug} deleted`,
      `Clean up: directory ${join(root, p.slug)} deleted`,
    ]);
    expect(rows.every((r) => r.actor === "operator" && r.from === "dismissed" && r.to === "dismissed")).toBe(true);
    expect(ds.listCommands()[0]).toMatchObject({ type: "cleanup-build", status: "applied" });
  });

  it("is not applied by the synchronous command pass", () => {
    const ds = Datastore.open(":memory:");
    const root = tempDir("argus-clean-");
    const p = built(ds, root);
    ds.enqueueCommand(p.id, "cleanup-build");
    expect(applyPending(ds)).toBe(0);
    expect(ds.listCommands()[0]!.status).toBe("pending");
    expect(existsSync(join(root, p.slug))).toBe(true);
  });

  it("rejects the command for a launched Proposal and touches nothing", async () => {
    const ds = Datastore.open(":memory:");
    const root = tempDir("argus-clean-");
    for (const status of ["launched", "closed-after-launch", "built", "approved"] as const) {
      const p = seed(ds, status);
      ds.markWorkerDeployed(p.id);
      ds.recordBuildRepo(p.id, `luis/${p.slug}`);
      checkout(root, p.slug, `https://github.com/luis/${p.slug}`);
      ds.enqueueCommand(p.id, "cleanup-build");
    }
    const { fetch, calls } = fakeFetch([() => json(200)]);
    expect(await runPendingCleanups(ds, opts(root, { fetch }))).toBe(4);
    expect(calls).toEqual([]);
    expect(ds.listCommands().map((c) => c.status)).toEqual(["rejected", "rejected", "rejected", "rejected"]);
    for (const p of ds.listProposals()) expect(existsSync(join(root, p.slug)), p.status).toBe(true);
  });

  it("a second run reports everything already gone and writes no error", async () => {
    const ds = Datastore.open(":memory:");
    const root = tempDir("argus-clean-");
    const p = built(ds, root);
    ds.enqueueCommand(p.id, "cleanup-build");
    await runPendingCleanups(ds, opts(root, { fetch: fakeFetch(happy(p)).fetch }));
    const gone = fakeFetch([
      cfWorker(p.slug, () => json(404, { errors: [{ code: 10007, message: "This Worker does not exist on your account." }] })),
      ghRepo(`luis/${p.slug}`, () => json(404, { message: "Not Found" }), () => json(404)),
    ]);
    ds.enqueueCommand(p.id, "cleanup-build");
    expect(await runPendingCleanups(ds, opts(root, { fetch: gone.fetch }))).toBe(1);
    const lines = ds.historyFor(p.id).filter((h) => h.reason.startsWith("Clean up:")).slice(3).map((h) => h.reason);
    expect(lines).toEqual([`Clean up: Worker ${p.slug} already gone`, `Clean up: repo luis/${p.slug} already gone`, `Clean up: directory ${join(root, p.slug)} already gone`]);
    expect(ds.listCommands().map((c) => c.status)).toEqual(["applied", "applied"]);
    expect(ds.getProposal(p.id)!.buildCleaned).toBe(true);
  });

  it("a Cloudflare 404 without error 10007 is not a 'gone' answer", async () => {
    const ds = Datastore.open(":memory:");
    const root = tempDir("argus-clean-");
    const p = built(ds, root);
    const f = fakeFetch([cfWorker(p.slug, () => json(404, { errors: [{ code: 7003 }] })), ...happy(p).slice(1)]);
    const run = await cleanupBuild(p, opts(root, { fetch: f.fetch }));
    expect(run.results[0]).toMatchObject({ outcome: "failed" });
    expect(run.cleaned).toBe(false);
  });

  it("with GitHub refusing for a missing scope: the Worker and directory are deleted, the repo failed with the fix, and a re-run finishes the repo only", async () => {
    const ds = Datastore.open(":memory:");
    const root = tempDir("argus-clean-");
    const p = built(ds, root);
    const scope = fakeFetch([
      cfWorker(p.slug, () => json(200)),
      ghRepo(`luis/${p.slug}`, () => privateRepo(`luis/${p.slug}`), () => json(403, { message: "Must have admin rights to Repository." })),
    ]);
    ds.enqueueCommand(p.id, "cleanup-build");
    await runPendingCleanups(ds, opts(root, { fetch: scope.fetch }));
    const first = ds.historyFor(p.id).filter((h) => h.reason.startsWith("Clean up:")).map((h) => h.reason);
    expect(first[0]).toBe(`Clean up: Worker ${p.slug} deleted`);
    expect(first[1]).toContain("failed");
    expect(first[1]).toContain("gh auth refresh -h github.com -s delete_repo");
    expect(first[2]).toBe(`Clean up: directory ${join(root, p.slug)} deleted`);
    expect(ds.getProposal(p.id)!.buildCleaned).toBe(false);

    const again = fakeFetch([
      cfWorker(p.slug, () => json(404, { errors: [{ code: 10007 }] })),
      ghRepo(`luis/${p.slug}`, () => privateRepo(`luis/${p.slug}`), () => new Response(null, { status: 204 })),
    ]);
    ds.enqueueCommand(p.id, "cleanup-build");
    await runPendingCleanups(ds, opts(root, { fetch: again.fetch }));
    const second = ds.historyFor(p.id).filter((h) => h.reason.startsWith("Clean up:")).slice(3).map((h) => h.reason);
    expect(second).toEqual([`Clean up: Worker ${p.slug} already gone`, `Clean up: repo luis/${p.slug} deleted`, `Clean up: directory ${join(root, p.slug)} already gone`]);
    expect(ds.getProposal(p.id)!.buildCleaned).toBe(true);
  });

  it("after a full clean-up a re-queue is no longer held back by the directory or the repo", async () => {
    const ds = Datastore.open(":memory:");
    const root = tempDir("argus-clean-");
    const p = seed(ds, "build-failed");
    ds.markWorkerDeployed(p.id);
    ds.recordBuildRepo(p.id, `luis/${p.slug}`);
    checkout(root, p.slug, `https://github.com/luis/${p.slug}`);
    const before = ds.getProposal(p.id)!;
    expect(requeueLeftovers(before, { buildRoot: root, githubRepoExists: () => true }).length).toBeGreaterThan(0);
    ds.enqueueCommand(p.id, "cleanup-build");
    await runPendingCleanups(ds, opts(root, { fetch: fakeFetch(happy(p)).fetch }));
    expect(requeueLeftovers(ds.getProposal(p.id)!, { buildRoot: root, githubRepoExists: () => false })).toEqual([]);
    ds.enqueueCommand(p.id, "requeue");
    expect(applyPending(ds, undefined, { buildRoot: root })).toBe(1);
    expect(ds.getProposal(p.id)!).toMatchObject({ status: "approved", buildCleaned: true });
    // A fresh Build starts with nothing recorded from the old one.
    ds.beginBuild(p.id, { backend: "claude-code", model: "m" });
    expect(ds.getProposal(p.id)).toMatchObject({ buildRepo: null, buildCleaned: false, workerDeployed: false });
  });
});

describe("ownership: what is left in place", () => {
  it("a Worker is deleted only when this Build deployed it", async () => {
    const ds = Datastore.open(":memory:");
    const root = tempDir("argus-clean-");
    const p = built(ds, root, { deployed: false });
    const f = fakeFetch(happy(p));
    const run = await cleanupBuild(p, opts(root, { fetch: f.fetch }));
    expect(f.calls.some((c) => c.url.includes("cloudflare"))).toBe(false);
    expect(run.results[0]).toMatchObject({ outcome: "skipped" });
    expect(cleanupLine(run.results[0]!)).toBe(`Clean up: Worker ${p.slug} skipped (not ours: this Build did not deploy a Worker)`);
  });

  it("a symlink at the checkout path is not followed or removed", async () => {
    const ds = Datastore.open(":memory:");
    const root = tempDir("argus-clean-");
    const elsewhere = tempDir("argus-elsewhere-");
    const p = seed(ds, "dismissed");
    ds.markWorkerDeployed(p.id);
    ds.recordBuildRepo(p.id, `luis/${p.slug}`);
    checkout(elsewhere, "real", `https://github.com/luis/${p.slug}`);
    symlinkSync(join(elsewhere, "real"), join(root, p.slug));
    const run = await cleanupBuild(ds.getProposal(p.id)!, opts(root, { fetch: fakeFetch(happy(p)).fetch }));
    expect(run.results[2]).toMatchObject({ outcome: "skipped", clear: false });
    expect(existsSync(join(elsewhere, "real", "SPEC.md"))).toBe(true);
    expect(run.cleaned).toBe(false);
  });

  it("a directory with a foreign or missing origin is not removed", async () => {
    const ds = Datastore.open(":memory:");
    for (const origin of ["https://github.com/someone/else.git", "https://github.com/someone/PLACEHOLDER.git", null, "https://example.com/luis/PLACEHOLDER.git"]) {
      const root = tempDir("argus-clean-");
      const p = seed(ds, "dismissed");
      ds.recordBuildRepo(p.id, `luis/${p.slug}`);
      checkout(root, p.slug, origin === null ? null : origin.replace("PLACEHOLDER", p.slug));
      const run = await cleanupBuild(ds.getProposal(p.id)!, opts(root, { fetch: fakeFetch(happy(p)).fetch }));
      expect(run.results[2], String(origin)).toMatchObject({ outcome: "skipped", clear: false });
      expect(existsSync(join(root, p.slug, "SPEC.md"))).toBe(true);
    }
  });

  it("a checkout without the Build's template remote is not removed", async () => {
    const ds = Datastore.open(":memory:");
    const root = tempDir("argus-clean-");
    const p = seed(ds, "dismissed");
    ds.recordBuildRepo(p.id, `luis/${p.slug}`);
    mkdirSync(join(root, p.slug, ".git"), { recursive: true });
    writeFileSync(join(root, p.slug, ".git", "config"), `[remote "origin"]\n\turl = https://github.com/luis/${p.slug}.git\n`);
    const run = await cleanupBuild(ds.getProposal(p.id)!, opts(root, { fetch: fakeFetch(happy(p)).fetch }));
    expect(run.results[2]).toMatchObject({ outcome: "skipped" });
    expect(existsSync(join(root, p.slug))).toBe(true);
  });

  it("a slug with .. or a slash deletes nothing and calls nothing", async () => {
    const ds = Datastore.open(":memory:");
    const root = tempDir("argus-clean-");
    const outside = tempDir("argus-outside-");
    checkout(outside, "victim", "https://github.com/luis/victim");
    const base = seed(ds, "dismissed");
    for (const slug of ["../victim", `${root}/../x`, "a/b", "..", "UPPER", "a--", ""]) {
      const p = { ...ds.getProposal(base.id)!, slug, workerDeployed: true, buildRepo: `luis/${slug}` };
      const f = fakeFetch([() => json(200)]);
      const run = await cleanupBuild(p, opts(root, { fetch: f.fetch }), `luis/${slug}`);
      expect(f.calls, slug).toEqual([]);
      expect(run.results.every((r) => r.outcome === "skipped" || r.outcome === "already gone" || r.outcome === "failed"), slug).toBe(true);
      expect(run.results.some((r) => r.outcome === "deleted"), slug).toBe(false);
    }
    expect(existsSync(join(outside, "victim", "SPEC.md"))).toBe(true);
  });

  it("a repo that is not private, or that GitHub names differently, is not deleted", async () => {
    const ds = Datastore.open(":memory:");
    const root = tempDir("argus-clean-");
    const p = built(ds, root);
    for (const body of [{ full_name: `luis/${p.slug}`, private: false }, { full_name: `luis/${p.slug}` }, { full_name: "luis/renamed", private: true }]) {
      const f = fakeFetch([ghRepo(`luis/${p.slug}`, () => json(200, body), () => json(204)), cfWorker(p.slug, () => json(200))]);
      const run = await cleanupBuild(p, opts(root, { fetch: f.fetch }));
      expect(run.results[1], JSON.stringify(body)).toMatchObject({ outcome: "skipped", clear: false });
      expect(f.calls.some((c) => c.method === "DELETE" && c.url.includes("github")), JSON.stringify(body)).toBe(false);
      expect(run.cleaned).toBe(false);
    }
  });
});

describe("a Build from before repos were recorded", () => {
  const legacy = (ds: Datastore, root: string, origin?: string) => built(ds, root, { repo: null, origin });

  it("is shown with the repo its checkout names", () => {
    const ds = Datastore.open(":memory:");
    const root = tempDir("argus-clean-");
    const p = legacy(ds, root);
    expect(cleanupPlan(p, root)).toEqual({
      worker: { name: p.slug, found: true },
      repo: { name: `luis/${p.slug}`, found: true, legacy: true },
      directory: { path: join(root, p.slug), found: true },
    });
  });

  it("keeps the repo and the checkout until the Operator types the repo name", async () => {
    const ds = Datastore.open(":memory:");
    const root = tempDir("argus-clean-");
    const p = legacy(ds, root);
    for (const typed of ["", p.slug, `luis/${p.slug}x`]) {
      const f = fakeFetch([...happy(p), ghUser("luis")]);
      const run = await cleanupBuild(p, opts(root, { fetch: f.fetch }), typed);
      expect(run.results[1], typed).toMatchObject({ outcome: "skipped", clear: false });
      expect(run.results[2], typed).toMatchObject({ outcome: "skipped" });
      expect(f.calls.some((c) => c.method === "DELETE" && c.url.includes("github"))).toBe(false);
      expect(existsSync(join(root, p.slug))).toBe(true);
    }
  });

  it("deletes the repo and then the checkout on the typed name, and a second run says gone", async () => {
    const ds = Datastore.open(":memory:");
    const root = tempDir("argus-clean-");
    const p = legacy(ds, root);
    ds.enqueueCommand(p.id, "cleanup-build", `luis/${p.slug}`);
    await runPendingCleanups(ds, opts(root, { fetch: fakeFetch([...happy(p), ghUser("luis")]).fetch }));
    expect(existsSync(join(root, p.slug))).toBe(false);
    expect(ds.getProposal(p.id)).toMatchObject({ buildRepo: `luis/${p.slug}`, buildCleaned: true });
    const second = await cleanupBuild(ds.getProposal(p.id)!, opts(root, { fetch: fakeFetch([cfWorker(p.slug, () => json(404, { errors: [{ code: 10007 }] })), ghRepo(`luis/${p.slug}`, () => json(404), () => json(404))]).fetch }));
    expect(second.results.map((r) => r.outcome)).toEqual(["already gone", "already gone", "already gone"]);
  });

  it("keeps the checkout when the repo delete fails (its origin is the only proof)", async () => {
    const ds = Datastore.open(":memory:");
    const root = tempDir("argus-clean-");
    const p = legacy(ds, root);
    const f = fakeFetch([cfWorker(p.slug, () => json(200)), ghUser("luis"), ghRepo(`luis/${p.slug}`, () => privateRepo(`luis/${p.slug}`), () => json(403))]);
    const run = await cleanupBuild(p, opts(root, { fetch: f.fetch }), `luis/${p.slug}`);
    expect(run.results.map((r) => r.outcome)).toEqual(["deleted", "failed", "skipped"]);
    expect(existsSync(join(root, p.slug, "SPEC.md"))).toBe(true);
  });

  it("does not delete a repo of an account the token does not belong to", async () => {
    const ds = Datastore.open(":memory:");
    const root = tempDir("argus-clean-");
    // an origin that names a repo with another name than the slug proves nothing: no repo is derived at all
    const other = legacy(ds, root, "https://github.com/victim/placeholder.git");
    expect(cleanupPlan(other, root).repo).toMatchObject({ name: null, legacy: false });
    // the agent can rewrite its checkout's origin to someone else's repo called the slug: the owner must be the token's account
    const mine = seed(ds, "dismissed");
    ds.markWorkerDeployed(mine.id);
    checkout(root, mine.slug, `https://github.com/victim/${mine.slug}.git`);
    const f = fakeFetch([ghUser("luis"), ghRepo(`victim/${mine.slug}`, () => privateRepo(`victim/${mine.slug}`), () => json(204)), cfWorker(mine.slug, () => json(200))]);
    const run = await cleanupBuild(ds.getProposal(mine.id)!, opts(root, { fetch: f.fetch }), `victim/${mine.slug}`);
    expect(run.results[1]).toMatchObject({ outcome: "skipped", clear: false });
    expect(f.calls.some((c) => c.method === "DELETE" && c.url.includes("github"))).toBe(false);
  });
});

describe("credentials", () => {
  it("never appear in a result, a history row or a log line, whatever the services say", async () => {
    const ds = Datastore.open(":memory:");
    const root = tempDir("argus-clean-");
    const p = built(ds, root);
    const leaky = (async (url: string | URL | Request) => {
      throw new Error(`connect failed for ${String(url)} with Bearer ${CF_TOKEN} and ${GH_TOKEN} (${encodeURIComponent(GH_TOKEN)})`);
    }) as typeof fetch;
    const logs: string[] = [];
    ds.enqueueCommand(p.id, "cleanup-build");
    await runPendingCleanups(ds, opts(root, { fetch: leaky, log: (l) => logs.push(l) }));
    const everything = JSON.stringify([ds.historyFor(p.id), ds.listCommands(), ds.getProposal(p.id), logs]);
    expect(everything).not.toContain(CF_TOKEN);
    expect(everything).not.toContain(GH_TOKEN);
    expect(everything).toContain("[redacted]");
  });

  it("a missing Cloudflare token or GitHub token fails with a message naming what to set", async () => {
    const ds = Datastore.open(":memory:");
    const root = tempDir("argus-clean-");
    const p = built(ds, root);
    const run = await cleanupBuild(p, { buildRoot: root, env: {}, githubToken: () => undefined, fetch: fakeFetch([]).fetch });
    expect(run.results[0]!.detail).toContain("CLOUDFLARE_API_TOKEN");
    expect(run.results[0]!.detail).toContain("CLOUDFLARE_ACCOUNT_ID");
    expect(run.results[1]).toMatchObject({ outcome: "failed" });
    expect(run.results[1]!.detail).toContain("GH_TOKEN");
  });

  it("a Cloudflare 403 names the permission the token needs", async () => {
    const ds = Datastore.open(":memory:");
    const root = tempDir("argus-clean-");
    const p = built(ds, root);
    const run = await cleanupBuild(p, opts(root, { fetch: fakeFetch([cfWorker(p.slug, () => json(403))]).fetch }));
    expect(run.results[0]!.detail).toContain("Workers Scripts: Edit");
  });
});

describe("parseGithubRepo", () => {
  it("reads https, scp-like and ssh github.com remotes and nothing else", () => {
    expect(parseGithubRepo("https://github.com/luis/cat.git")).toBe("luis/cat");
    expect(parseGithubRepo("https://github.com/luis/cat")).toBe("luis/cat");
    expect(parseGithubRepo("git@github.com:luis/cat.git")).toBe("luis/cat");
    expect(parseGithubRepo("ssh://git@github.com/luis/cat.git")).toBe("luis/cat");
    expect(parseGithubRepo("https://gitlab.com/luis/cat")).toBeNull();
    expect(parseGithubRepo("https://github.com.evil.com/luis/cat")).toBeNull();
    expect(parseGithubRepo("/some/path/cat")).toBeNull();
    expect(parseGithubRepo("https://github.com/luis/cat/extra")).toBeNull();
  });
});
