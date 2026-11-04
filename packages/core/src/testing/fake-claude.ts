import { join } from "node:path";

/** Absolute path of the shared fake `claude` executable (see fake-claude.mjs). */
export const FAKE_CLAUDE = join(import.meta.dirname, "fake-claude.mjs");
