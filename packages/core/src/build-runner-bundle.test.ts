import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tempDir, tempPath } from "./testing/temp.ts";
import { basename, dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { checkMetafile, findUnsafeEntries, runNextBuild } from "./build-runner.ts";
import { makeHarness, TEST_IMAGE, type Harness } from "./testing/build-harness.ts";

/** Runs one Build and returns the Proposal after, its last status reason, and what the fake wrangler saw. */
const flagValues = (argv: string[], flag: string) => argv.flatMap((a, i) => (a === flag ? [argv[i + 1]!] : []));

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

// Each test runs whole Builds: git, a container's worth of fake processes, a bundle and a deploy. Under load that is not 5 s.
describe("the deploy bundle holds only files of the committed tree", { timeout: 60_000 }, () => {
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
    expect(r.bundle).toHaveLength(2); // the attempt and its retry
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

  it("installs the committed dependencies and bundles a Worker that imports an npm package inside containers, and the host check passes", async () => {
    const dep = "node_modules/left-pad/index.js";
    const h = makeHarness({
      claudeEnv: { FAKE_CLAUDE_EFFECT: "index-from-env,commit", FAKE_CLAUDE_INDEX_TS: 'import pad from "left-pad";\nexport default { fetch: () => new Response(pad("x", 3)) };\n' },
      // What `pnpm install --frozen-lockfile` leaves in the export, and the input esbuild then lists for the import.
      podmanEnv: { FAKE_PODMAN_INSTALL_FILES: JSON.stringify({ [dep]: "module.exports = (s) => s;\n" }) },
      wranglerEnv: { FAKE_WRANGLER_META_INPUTS: JSON.stringify([`export/${dep}`]) },
    });
    const r = await build(h);
    expect(r.after.status).toBe("built");

    // Two containers of the same image, in this order, then the host deploys: install (proxy only), bundle (no network at all).
    const runs = h.podmanCalls().filter((c) => c[0] === "run" && !c.includes("-d"));
    const roles = runs.map((c) => c[c.indexOf("--label", c.indexOf("--label") + 1) + 1]);
    expect(roles).toEqual(["argus.role=agent", "argus.role=install", "argus.role=bundle"]);
    const [, install, bundle] = runs as [string[], string[], string[]];
    expect(install.slice(install.indexOf(TEST_IMAGE) + 1)).toEqual(["pnpm", "install", "--frozen-lockfile"]);
    expect(install[install.indexOf("--network") + 1]).toBe("argus-build-net");
    expect(bundle[bundle.indexOf("--network") + 1]).toBe("none");
    expect(bundle.slice(bundle.indexOf(TEST_IMAGE) + 1).slice(0, 2)).toEqual(["wrangler", "deploy"]);
    // The project's own wrangler (from the lockfile install) is found through PATH, ahead of the image's directories.
    expect(flagValues(bundle, "--env").find((e) => e.startsWith("PATH="))).toMatch(/^PATH=\S*\/work\/export\/node_modules\/\.bin:\/usr\/local\/bin:/);
    for (const c of [install, bundle]) {
      expect(c.join(" ")).not.toContain("CLAUDE_CODE_OAUTH_TOKEN");
      expect(c.join(" ")).not.toContain("CLOUDFLARE");
    }

    // The dependency was in the export when the bundler ran, and the bundle step had no credentials.
    const [bundleCall] = r.bundle;
    expect(bundleCall!.rootListing).toContain("node_modules");
    expect(bundleCall!.cf).toEqual({});
    expect(r.deploys).toHaveLength(1);
    expect(h.containers()).toEqual([]);
  });

  it("fails the Build, bundling and deploying nothing, when the dependency install fails (for example a lockfile that does not match)", async () => {
    const h = makeHarness({ podmanEnv: { FAKE_PODMAN_INSTALL_FAIL: "1" } });
    const r = await build(h);
    expect(r.after.status).toBe("build-failed");
    expect(r.reason).toContain("dependency install failed");
    expect(r.reason).toContain("ERR_PNPM_OUTDATED_LOCKFILE");
    expect(r.calls).toEqual([]);
    expect(h.containers()).toEqual([]);
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
    // It is uploaded from a fresh directory holding only the checked entry file, never from the outdir as it was left.
    // The upload directory and the deploy's working directory are argus's own (the seal), never the directory the bundle container
    // wrote to (`work`, which is the bundle's cwd): wrangler loads .env files and config from its cwd.
    const seal = dirname(bundle!.cwd);
    expect(JSON.parse(deploy!.configText as string).main).toBe(`${seal}/upload/index.js`);
    expect(deploy!.main).toBe(`${seal}/upload/index.js`);
    expect(deploy!.mainListing).toEqual(["index.js"]);
    expect(deploy!.mainText).toContain("bundled by the fake");
    expect(JSON.parse(deploy!.configText as string).rules).toEqual(JSON.parse(bundle!.configText as string).rules);
    expect(deploy!.cf).toEqual({ CLOUDFLARE_API_TOKEN: "cf-secret", CLOUDFLARE_ACCOUNT_ID: "acct" });
    expect(deploy!.cwd).toBe(seal);
    expect(deploy!.cwd).not.toBe(bundle!.cwd);
  });
});

describe("the bundle's output directory holds only what is expected", { timeout: 60_000 }, () => {
  it("rejects a Build when wrangler left a file in the outdir besides the entry, its map and README.md, and deploys nothing", async () => {
    const h = makeHarness({ wranglerEnv: { FAKE_WRANGLER_OUT_EXTRA: JSON.stringify(["188e772cbd5dc38f6f8675060f53c929581de722-secret.txt"]) } });
    const r = await build(h);
    expect(r.after.status).toBe("build-failed");
    expect(r.reason).toContain("188e772cbd5dc38f6f8675060f53c929581de722-secret.txt");
    expect(r.reason).toContain("refusing to deploy");
    expect(r.bundle).toHaveLength(2); // the attempt and its retry
    expect(r.deploys).toEqual([]);
  });

  it("rejects an extra directory in the outdir too", async () => {
    const h = makeHarness({ wranglerEnv: { FAKE_WRANGLER_OUT_EXTRA: JSON.stringify(["node_modules"]) } });
    const r = await build(h);
    expect(r.after.status).toBe("build-failed");
    expect(r.deploys).toEqual([]);
  });

  it("gives the bundle step a config that collects no Text, Data or CompiledWasm module", async () => {
    const h = makeHarness();
    const r = await build(h);
    const { rules } = JSON.parse(r.bundle[0]!.configText as string);
    expect(rules.map((x: any) => x.type).sort()).toEqual(["CompiledWasm", "Data", "Text"]);
    for (const rule of rules) expect(rule.fallthrough).toBe(false);
  });
});

describe("checkMetafile: every input is a plain path to a regular file inside the export", () => {
  let dir = "";
  let exportDir = "";
  let outdir = "";
  beforeAll(() => {
    dir = tempDir("argus-meta-");
    exportDir = join(dir, "export");
    outdir = join(dir, "dist");
    mkdirSync(join(exportDir, "src"), { recursive: true });
    mkdirSync(join(exportDir, "node_modules/dep"), { recursive: true });
    mkdirSync(outdir);
    writeFileSync(join(exportDir, "src/index.ts"), "");
    writeFileSync(join(exportDir, "src/a.js"), "");
    writeFileSync(join(exportDir, "node_modules/dep/index.js"), "");
    writeFileSync(join(outdir, "index.js"), "");
    writeFileSync(join(dir, "outside.json"), "{}");
    symlinkSync(join(dir, "outside.json"), join(exportDir, "src/link.json"));
  });
  const meta = (...inputs: string[]) => ({
    inputs: Object.fromEntries(inputs.map((f) => [f, { bytes: 1, imports: [] }])),
    outputs: { "dist/index.js": { entryPoint: "export/src/index.ts", inputs: {}, imports: [], exports: [], bytes: 1 } },
  });
  const check = (...inputs: string[]) => checkMetafile(meta(...inputs), dir, exportDir, outdir);

  it("accepts the entry, a sibling and the export's own node_modules", () => {
    expect(check("export/src/index.ts", "export/src/a.js", "export/node_modules/dep/index.js")).toEqual({ output: join(outdir, "index.js") });
  });

  it.each([
    ["a ? suffix whose ../ climbs back into the export", "outside.json?/../export/src/a.js"],
    ["a # suffix whose ../ climbs back into the export", "outside.json#/../export/src/a.js"],
    ["a ? suffix on a file inside the export", "export/src/a.js?x"],
    ["a # suffix on a file inside the export", "export/src/a.js#x"],
    ["a NUL", "export/src/a.js\0"],
    ["a backslash", "export\\src\\a.js"],
    ["a URL scheme", "https://example.com/export/src/a.js"],
    ["a file: URL", "file:export/src/a.js"],
    ["an absolute path, even one inside the export", "<abs>"],
    ["a file that does not exist", "export/src/missing.js"],
    ["a directory", "export/src"],
    ["a symlink out of the export", "export/src/link.json"],
    ["a path that climbs out", "outside.json"],
  ])("rejects %s", (_what, raw) => {
    const input = raw === "<abs>" ? join(exportDir, "src/a.js") : raw;
    expect(check("export/src/index.ts", input)).toEqual({ outside: [input] });
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
  const secret = tempPath("secret", ".json");
  beforeAll(() => writeFileSync(secret, '{"secret":"operator-only"}\n'));
  afterAll(() => rmSync(secret, { force: true }));

  /** A Build whose committed src/index.ts is `source`, run with the real wrangler for the bundle step. */
  async function realBuild(source: string, files: Record<string, string> = {}) {
    const h = makeHarness({ claudeEnv: { FAKE_CLAUDE_EFFECT: "index-from-env,write-files,commit", FAKE_CLAUDE_INDEX_TS: source, FAKE_CLAUDE_FILES: JSON.stringify(files) } });
    const deployLog = join(h.root, "real-deploys.log");
    const wrapper = join(h.root, "wrangler-wrapper.sh");
    writeFileSync(wrapper, `#!/bin/sh\nfor a in "$@"; do [ "$a" = "--dry-run" ] && exec wrangler "$@"; done\necho "$@" >> '${deployLog}'\necho 'https://cat-coin.fake-account.workers.dev'\n`);
    chmodSync(wrapper, 0o755);
    h.options.wranglerBin = wrapper;
    h.sandboxEnv.FAKE_PODMAN_WRANGLER = wrapper; // what `pnpm exec wrangler` runs in the fake container
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
    // From <tmp>/argus-build-x/data/proposals/<id>/seal-x/work/export/src, eight levels up is the temp dir.
    const r = await realBuild(worker(`import data from "${"../".repeat(8)}${basename(secret)}";`));
    expect(r.status).toBe("build-failed");
    expect(r.reason).toContain("outside");
    expect(r.reason).toContain(basename(secret));
    expect(r.deployed).toEqual([]);
  });

  // wrangler's default module rules copy an imported .txt, .html, .bin or .wasm into --outdir as an external module that the
  // metafile does not list as an input, and a --no-bundle deploy uploads everything beside the entry. argus's config redefines
  // those rules so the bundler refuses such an import, wherever the file is.
  for (const ext of ["txt", "html", "bin", "wasm"]) {
    it(`rejects an import of a .${ext} file outside the export, and deploys nothing`, async () => {
      const outside = tempPath("secret", `.${ext}`);
      writeFileSync(outside, ext === "wasm" ? "\0asm\u0001\0\0\0" : "SECRET-OUTSIDE");
      try {
        const r = await realBuild(worker(`import data from ${JSON.stringify(outside)};`));
        expect(r.status).toBe("build-failed");
        expect(r.reason).toContain("wrangler bundle failed");
        expect(r.deployed).toEqual([]);
        expect(existsSync(join(r.h.root, "real-deploys.log"))).toBe(false);
      } finally {
        rmSync(outside, { force: true });
      }
    });

    it(`rejects an import of a committed .${ext} file inside the export too (Workers with module imports are refused), and deploys nothing`, async () => {
      const r = await realBuild(worker(`import data from "./asset.${ext}";`), { [`src/asset.${ext}`]: ext === "wasm" ? "\0asm\u0001\0\0\0" : "INSIDE" });
      expect(r.status).toBe("build-failed");
      expect(r.reason).toContain("wrangler bundle failed");
      expect(r.deployed).toEqual([]);
    });
  }

  // esbuild accepts a ? or # suffix on an import path and the metafile records it raw, so `wrangler.jsonc?/../export/x`
  // (cwd-relative) normalises back inside the export while the bundler read the file in the seal, outside it.
  for (const mark of ["?", "#"]) {
    it(`rejects a ${mark} suffix whose ../ climbs back into the export, and deploys nothing`, async () => {
      // From <seal>/work/export/src, two levels up is the work directory, which holds argus's own bundle config.
      const r = await realBuild(worker(`import data from "../../wrangler.jsonc${mark}/../export/x" with { type: "json" };`));
      expect(r.status).toBe("build-failed");
      expect(r.reason).toContain("outside the commit");
      expect(r.reason).toContain(`wrangler.jsonc${mark}/../export/x`);
      expect(r.deployed).toEqual([]);
    });
  }

  it("rejects an absolute import of a file outside the export, and deploys nothing", async () => {
    const r = await realBuild(worker(`import data from ${JSON.stringify(secret)};`));
    expect(r.status).toBe("build-failed");
    expect(r.reason).toContain("outside");
    expect(r.reason).toContain(basename(secret));
    expect(r.deployed).toEqual([]);
  });
});
