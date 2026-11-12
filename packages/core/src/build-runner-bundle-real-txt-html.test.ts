import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { tempPath } from "./testing/temp.ts";
import { hasWrangler, realBuild, worker } from "./testing/real-wrangler-build.ts";

// wrangler's default module rules copy an imported .txt, .html, .bin or .wasm into --outdir as an external module that the
// metafile does not list as an input, and a --no-bundle deploy uploads everything beside the entry. argus's config redefines
// those rules so the bundler refuses such an import, wherever the file is.
describe.skipIf(!hasWrangler)("with the real wrangler (--dry-run only): .txt and .html imports", { timeout: 120_000 }, () => {
  for (const ext of ["txt", "html"]) {
    it(`rejects an import of a .${ext} file outside the export, and deploys nothing`, async () => {
      const outside = tempPath("secret", `.${ext}`);
      writeFileSync(outside, "SECRET-OUTSIDE");
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
      const r = await realBuild(worker(`import data from "./asset.${ext}";`), { [`src/asset.${ext}`]: "INSIDE" });
      expect(r.status).toBe("build-failed");
      expect(r.reason).toContain("wrangler bundle failed");
      expect(r.deployed).toEqual([]);
    });
  }
});
