import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { makeHarness, TEST_IMAGE } from "./testing/build-harness.ts";
import { build, flagValues } from "./testing/bundle-build.ts";

// The output-directory, metafile and tree checks are in build-runner-bundle-outdir.test.ts, the real-wrangler ones in
// build-runner-bundle-real*.test.ts: split so vitest can spread them over its workers.

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
