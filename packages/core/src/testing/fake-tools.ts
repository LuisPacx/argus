import { join } from "node:path";

/** Absolute paths of the fake `gh` and `wrangler` executables (see fake-gh.mjs, fake-wrangler.mjs). */
export const FAKE_GH = join(import.meta.dirname, "fake-gh.mjs");
export const FAKE_WRANGLER = join(import.meta.dirname, "fake-wrangler.mjs");
/** The fake `podman` (see fake-podman.mjs): it runs the fake claude and wrangler as the contents of the "container". */
export const FAKE_PODMAN = join(import.meta.dirname, "fake-podman.mjs");
