import { basename } from "node:path";
import { describe, expect, it } from "vitest";
import { hasWrangler, realBuild, useSecret, worker } from "./testing/real-wrangler-build.ts";

const secret = useSecret();

describe.skipIf(!hasWrangler)("with the real wrangler (--dry-run only)", { timeout: 120_000 }, () => {
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
