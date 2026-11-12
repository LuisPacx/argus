import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { checkMetafile, findUnsafeEntries } from "./build-runner.ts";
import { makeHarness } from "./testing/build-harness.ts";
import { build } from "./testing/bundle-build.ts";
import { tempDir } from "./testing/temp.ts";

// Each test runs whole Builds: git, a container's worth of fake processes, a bundle and a deploy. Under load that is not 5 s.
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
