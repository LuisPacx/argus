import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { findUnsafeEntries, runNextBuild } from "./build-runner.ts";
import { makeHarness, type Harness } from "./testing/build-harness.ts";

/** Runs one Build and returns the Proposal after, its last status reason, and what the fake wrangler saw. */
async function build(h: Harness) {
  const p = h.seedApproved("Cat Coin");
  const outcome = await runNextBuild(h.store, h.brain, h.options);
  const after = h.store.getProposal(p.id)!;
  const reason = h.store.historyFor(p.id).at(-1)!.reason;
  const calls = h.calls(h.wranglerLog);
  const flag = (c: Record<string, any>, name: string) => c.argv[c.argv.indexOf(name) + 1] as string;
  return {
    p,
    outcome,
    after,
    reason,
    calls,
    flag,
    bundle: calls.filter((c) => c.argv.includes("--dry-run")),
    deploys: calls.filter((c) => !c.argv.includes("--dry-run")),
  };
}

describe("the deploy bundle holds only files of the committed tree", () => {
  it("rejects a Build whose commit holds a symlink, and deploys nothing", async () => {
    const h = makeHarness({ claudeEnv: { FAKE_CLAUDE_EFFECT: "symlink-file,commit" } });
    const r = await build(h);
    expect(r.after.status).toBe("build-failed");
    expect(r.reason).toContain("symlink");
    expect(r.reason).toContain("src/link.txt");
    expect(r.calls).toEqual([]);
  });

  it("rejects a Build whose commit holds a submodule entry, and deploys nothing", async () => {
    const h = makeHarness({ claudeEnv: { FAKE_CLAUDE_EFFECT: "commit,gitlink" } });
    const r = await build(h);
    expect(r.after.status).toBe("build-failed");
    expect(r.reason).toContain("submodule");
    expect(r.reason).toContain("vendor/sub");
    expect(r.calls).toEqual([]);
  });

  it("rejects a Build when the bundler read a file outside the export through a ../ import, and deploys nothing", async () => {
    const h = makeHarness({ wranglerEnv: { FAKE_WRANGLER_META_INPUTS: JSON.stringify(["../../outside.json"]) } });
    const r = await build(h);
    expect(r.after.status).toBe("build-failed");
    expect(r.reason).toContain("outside");
    expect(r.reason).toContain("outside.json");
    expect(r.bundle).toHaveLength(1);
    expect(r.deploys).toEqual([]);
  });

  it("rejects a Build when the bundler read a file outside the export through an absolute import, and deploys nothing", async () => {
    const h = makeHarness({ wranglerEnv: { FAKE_WRANGLER_META_INPUTS: JSON.stringify(["/etc/hostname"]) } });
    const r = await build(h);
    expect(r.after.status).toBe("build-failed");
    expect(r.reason).toContain("/etc/hostname");
    expect(r.deploys).toEqual([]);
  });

  it("does not take a file named like the export but beside it for one inside it", async () => {
    const h = makeHarness({ wranglerEnv: { FAKE_WRANGLER_META_INPUTS: JSON.stringify(["export-evil/x.json"]) } });
    const r = await build(h);
    expect(r.after.status).toBe("build-failed");
    expect(r.deploys).toEqual([]);
  });

  it("accepts the export's own node_modules", async () => {
    const h = makeHarness({ wranglerEnv: { FAKE_WRANGLER_META_INPUTS: JSON.stringify(["export/node_modules/dep/index.js"]) } });
    const r = await build(h);
    expect(r.after.status).toBe("built");
  });

  it("bundles a fresh export of HEAD in the seal (not the agent's working tree), then deploys the checked output with --no-bundle", async () => {
    const h = makeHarness({ claudeEnv: { FAKE_CLAUDE_EFFECT: "commit,ignored-files" } });
    const r = await build(h);
    expect(r.after.status).toBe("built");
    // The ignored files really are in the agent's repo.
    expect(existsSync(join(h.repoDir("cat-coin"), "node_modules/dep/index.js"))).toBe(true);

    expect(r.calls).toHaveLength(2);
    const [bundle] = r.bundle;
    const [deploy] = r.deploys;
    expect(r.calls.indexOf(bundle!)).toBeLessThan(r.calls.indexOf(deploy!));

    // The bundle step: argus's config, in the seal, a metafile and an outdir of its own, and no Cloudflare credentials.
    const config = r.flag(bundle!, "--config");
    expect(bundle!.cwd).toBe(config.slice(0, config.lastIndexOf("/")));
    expect(r.flag(bundle!, "--outdir").startsWith(bundle!.cwd + "/")).toBe(true);
    expect(r.flag(bundle!, "--metafile").startsWith(bundle!.cwd + "/")).toBe(true);
    expect(bundle!.argv).toContain("--env-file");
    expect(bundle!.cf).toEqual({});
    // Its entry point is in an export of the commit: what is committed is there, what the agent left untracked or ignored is not.
    const exported = (bundle!.main as string).replace(/\/src\/index\.ts$/, "");
    expect(exported.startsWith(bundle!.cwd + "/")).toBe(true);
    expect(bundle!.rootListing).toContain("SPEC.md");
    expect(bundle!.rootListing).toContain("src");
    expect(bundle!.rootListing).not.toContain("node_modules");
    expect(bundle!.rootListing).not.toContain(".env");
    expect(bundle!.rootListing).not.toContain(".fake-sessions");
    expect(bundle!.rootListing).not.toContain(".git");

    // The deploy step: the output of that bundle, not bundled again, with the credentials.
    expect(deploy!.argv.slice(0, 3)).toEqual(["deploy", "--name", "cat-coin"]);
    expect(deploy!.argv).toContain("--no-bundle");
    expect(deploy!.argv).not.toContain("--dry-run");
    expect(JSON.parse(deploy!.configText as string).main).toBe(`${bundle!.cwd}/dist/index.js`);
    expect(deploy!.main).toBe(`${r.flag(bundle!, "--outdir")}/index.js`);
    expect(deploy!.mainText).toContain("bundled by the fake");
    expect(deploy!.cf).toEqual({ CLOUDFLARE_API_TOKEN: "cf-secret", CLOUDFLARE_ACCOUNT_ID: "acct" });
    expect(deploy!.cwd).toBe(bundle!.cwd);
  });
});

describe("findUnsafeEntries", () => {
  const entry = (mode: string, path: string) => `${mode} blob 0123456789abcdef0123456789abcdef01234567\t${path}\0`;

  it("flags symlinks, submodules, and paths that climb out or name a .git directory; plain files pass", () => {
    const tree = [entry("100644", "src/index.ts"), entry("100755", "scripts/run.sh"), entry("120000", "src/link"), entry("160000", "vendor/sub"), entry("100644", "a/../b"), entry("100644", "sub/.git/config")].join("");
    expect(findUnsafeEntries(tree)).toEqual([
      "a symlink: src/link",
      "a submodule: vendor/sub",
      'a path that climbs out: "a/../b"',
      'a path inside a .git directory: "sub/.git/config"',
    ]);
    expect(findUnsafeEntries(entry("100644", "src/index.ts") + entry("100644", "..foo/bar"))).toEqual([]);
    expect(findUnsafeEntries("")).toEqual([]);
  });
});

// The same checks against the real wrangler. Its --dry-run bundles exactly as a deploy does and uploads nothing; a wrapper
// passes only --dry-run calls through, and records (and fakes) any other, so no test here can ever deploy.
const hasWrangler = spawnSync("wrangler", ["--version"], { encoding: "utf8" }).status === 0;

describe.skipIf(!hasWrangler)("with the real wrangler (--dry-run only)", { timeout: 120_000 }, () => {
  // A file the Operator can read, outside anything a Build owns: beside the seal's parent, in the temp dir.
  const secret = join(tmpdir(), `argus-secret-${process.pid}-${Math.random().toString(36).slice(2)}.json`);
  beforeAll(() => writeFileSync(secret, '{"secret":"operator-only"}\n'));
  afterAll(() => rmSync(secret, { force: true }));

  /** A Build whose committed src/index.ts is `source`, run with the real wrangler for the bundle step. */
  async function realBuild(source: string) {
    const h = makeHarness({ claudeEnv: { FAKE_CLAUDE_EFFECT: "index-from-env,commit", FAKE_CLAUDE_INDEX_TS: source } });
    const deployLog = join(h.root, "real-deploys.log");
    const wrapper = join(h.root, "wrangler-wrapper.sh");
    writeFileSync(wrapper, `#!/bin/sh\nfor a in "$@"; do [ "$a" = "--dry-run" ] && exec wrangler "$@"; done\necho "$@" >> '${deployLog}'\necho 'https://cat-coin.fake-account.workers.dev'\n`);
    chmodSync(wrapper, 0o755);
    h.options.wranglerBin = wrapper;
    const p = h.seedApproved("Cat Coin");
    await runNextBuild(h.store, h.brain, h.options);
    const reason = h.store.historyFor(p.id).at(-1)!.reason;
    const deployed = existsSync(deployLog) ? readFileSync(deployLog, "utf8").trim().split("\n") : [];
    return { status: h.store.getProposal(p.id)!.status, reason, deployed, h };
  }
  const worker = (imports: string) => `${imports}\nexport default { fetch() { return new Response(JSON.stringify(data)); } };\n`;

  it("bundles a Build that imports only committed files, then deploys the bundle with --no-bundle", async () => {
    // src/feature.ts is what the fake claude commits besides index.ts.
    const r = await realBuild(`import { feature as data } from "./feature.ts";\nexport default { fetch() { return new Response(JSON.stringify(data)); } };\n`);
    expect(r.reason).not.toContain("outside");
    expect(r.status).toBe("built");
    expect(r.deployed).toHaveLength(1);
    expect(r.deployed[0]).toContain("--no-bundle");
  });

  it("rejects a ../ import of a file outside the export, and deploys nothing", async () => {
    // From <seal>/export/src, three levels up is the temp dir.
    const r = await realBuild(worker(`import data from "../../../${basename(secret)}";`));
    expect(r.status).toBe("build-failed");
    expect(r.reason).toContain("outside");
    expect(r.reason).toContain(basename(secret));
    expect(r.deployed).toEqual([]);
  });

  it("rejects an absolute import of a file outside the export, and deploys nothing", async () => {
    const r = await realBuild(worker(`import data from ${JSON.stringify(secret)};`));
    expect(r.status).toBe("build-failed");
    expect(r.reason).toContain("outside");
    expect(r.reason).toContain(basename(secret));
    expect(r.deployed).toEqual([]);
  });
});
