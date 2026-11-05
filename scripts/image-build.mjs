// `pnpm image:build`: builds the Build image and ensures the internal Build network (containment design section 6).
// Operator-run only. Stages a context of the Containerfile plus the two proxy files so the tag's content hash
// is exactly what gets built. Prints the tag on the last line.
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { CLAUDE_CODE_VERSION, PNPM_VERSION, ensureBuildNetwork, imageReady, imageTag } from "../packages/core/src/build-image.ts";

const podman = process.env.PODMAN ?? "podman";
const root = join(import.meta.dirname, "..");
const files = [
  join(root, "containers/build/Containerfile"),
  join(root, "packages/core/src/egress-proxy.mjs"),
  join(root, "packages/core/src/egress-proxy.ts"),
];
const containerfile = readFileSync(files[0], "utf8");
for (const pin of [`pnpm@${PNPM_VERSION}`, `@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}`]) {
  if (!containerfile.includes(pin)) throw new Error(`Containerfile does not pin ${pin}; update it together with build-image.ts`);
}
if (!/^FROM \S+@sha256:[0-9a-f]{64}$/m.test(containerfile)) throw new Error("Containerfile base image is not digest-pinned");

const tag = imageTag(files.map((f) => readFileSync(f, "utf8")));
console.log(`network: ${await ensureBuildNetwork(podman)}`);

if (await imageReady(tag, podman)) {
  console.log("image: up to date");
} else {
  const ctx = mkdtempSync(join(tmpdir(), "argus-image-"));
  try {
    for (const f of files) copyFileSync(f, join(ctx, basename(f)));
    const r = spawnSync(podman, ["build", "--pull=missing", "-t", tag, "-f", join(ctx, "Containerfile"), ctx], { stdio: "inherit" });
    if (r.status !== 0) throw new Error(`podman build failed (${r.status})`);
  } finally {
    rmSync(ctx, { recursive: true, force: true });
  }
  console.log("image: built");
}
console.log(tag);
