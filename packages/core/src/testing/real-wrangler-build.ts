import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll } from "vitest";
import { runNextBuild } from "../build-runner.ts";
import { makeHarness } from "./build-harness.ts";
import { tempPath } from "./temp.ts";

// The same checks against the real wrangler. Its --dry-run bundles exactly as a deploy does and uploads nothing; a wrapper
// passes only --dry-run calls through, and records (and fakes) any other, so no test here can ever deploy.
export const hasWrangler = spawnSync("wrangler", ["--version"], { encoding: "utf8" }).status === 0;

/** A file the Operator can read, outside anything a Build owns: beside the seal's parent, in the temp dir. Call once per file, at its top level. */
export function useSecret() {
  const secret = tempPath("secret", ".json");
  beforeAll(() => writeFileSync(secret, '{"secret":"operator-only"}\n'));
  afterAll(() => rmSync(secret, { force: true }));
  return secret;
}

/** A Build whose committed src/index.ts is `source`, run with the real wrangler for the bundle step. */
export async function realBuild(source: string, files: Record<string, string> = {}) {
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

export const worker = (imports: string) => `${imports}\nexport default { fetch() { return new Response(JSON.stringify(data)); } };\n`;
