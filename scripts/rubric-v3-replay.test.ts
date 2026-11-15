import { spawnSync } from "node:child_process";
import { symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Datastore } from "../packages/core/src/datastore.ts";
import { tempDir } from "../packages/core/src/testing/temp.ts";

const script = join(import.meta.dirname, "rubric-v3-replay.mjs");
const run = (args: string[], env: Record<string, string> = {}) =>
  spawnSync(process.execPath, [script, ...args], { encoding: "utf8", env: { ...process.env, ...env } });

describe("scripts/rubric-v3-replay.mjs guards", () => {
  const dir = tempDir("argus-rubric-replay-");

  it("is dry without --run: plans the replay, prints a prompt, spends nothing", () => {
    const copy = join(dir, "copy.db");
    Datastore.open(copy).close();
    const r = run([copy]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("(dry run)");
  });

  it("refuses the configured live database by realpath, including through a symlink", () => {
    const live = join(dir, "configured-live.db");
    writeFileSync(live, "x");
    const link = join(dir, "link.db");
    symlinkSync(live, link);
    for (const target of [live, link]) {
      const r = run([target, "--run"], { ARGUS_DB: live });
      expect(r.status).toBe(2);
      expect(r.stderr).toContain("refusing to open the live database");
    }
  });
});
