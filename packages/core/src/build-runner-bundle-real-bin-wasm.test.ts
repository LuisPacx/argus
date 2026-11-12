import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { tempPath } from "./testing/temp.ts";
import { hasWrangler, realBuild, worker } from "./testing/real-wrangler-build.ts";

// See build-runner-bundle-real-txt-html.test.ts: the same module-rule checks for .bin and .wasm.
describe.skipIf(!hasWrangler)("with the real wrangler (--dry-run only): .bin and .wasm imports", { timeout: 120_000 }, () => {
  for (const ext of ["bin", "wasm"]) {
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
});
