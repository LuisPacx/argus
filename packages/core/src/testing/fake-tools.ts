import { join } from "node:path";

/** Absolute paths of the fake `gh` and `wrangler` executables (see fake-gh.mjs, fake-wrangler.mjs). */
export const FAKE_GH = join(import.meta.dirname, "fake-gh.mjs");
export const FAKE_WRANGLER = join(import.meta.dirname, "fake-wrangler.mjs");
