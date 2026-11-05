import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/** Pinned versions; the Containerfile pins the same ones (image-build.mjs fails if they drift). */
export const CLAUDE_CODE_VERSION = "2.1.318";
export const NODE_VERSION = "22.23.4"; // of the digest-pinned base image
export const PNPM_VERSION = "11.2.2";

export const IMAGE_REPO = "localhost/argus-build";
export const BUILD_NETWORK = { name: "argus-build-net", subnet: "10.89.77.0/24", gateway: "10.89.77.1" };

/** Tag from the pinned versions and a content hash of the Containerfile and the proxy files. Never `latest`. */
export function imageTag(contents: readonly string[]): string {
  const hash = createHash("sha256");
  for (const c of contents) hash.update(`${c.length}:`).update(c);
  return `${IMAGE_REPO}:cc${CLAUDE_CODE_VERSION}-n${NODE_VERSION}-p${PNPM_VERSION}-${hash.digest("hex").slice(0, 12)}`;
}

/** The files whose content the tag hashes, relative to the repo root: what `pnpm image:build` puts in the image. */
export const IMAGE_CONTEXT_FILES = ["containers/build/Containerfile", "packages/core/src/egress-proxy.mjs", "packages/core/src/egress-proxy.ts"] as const;

/** The tag `pnpm image:build` gives the image built from the checkout at `repoRoot`. */
export function currentImageTag(repoRoot: string): string {
  return imageTag(IMAGE_CONTEXT_FILES.map((f) => readFileSync(join(repoRoot, f), "utf8")));
}

/** True when the image exists locally. The worker calls this before every Build; any failure counts as absent. `env`, when given, is the podman client's whole environment. */
export async function imageReady(tag: string, podman = "podman", env?: NodeJS.ProcessEnv): Promise<boolean> {
  try {
    await run(podman, ["image", "exists", tag], env ? { env } : {});
    return true;
  } catch {
    return false;
  }
}

interface NetworkInspect {
  internal?: boolean;
  dns_enabled?: boolean;
  subnets?: { subnet?: string }[];
}

/**
 * Idempotently ensures the internal, DNS-less Build network. An existing network is accepted when it is
 * internal, has DNS disabled and carries the expected subnet (its labels are not inspected); otherwise this
 * throws rather than recreating it. Returns whether it was created.
 */
export async function ensureBuildNetwork(podman = "podman", net = BUILD_NETWORK): Promise<"created" | "exists"> {
  let exists = true;
  try {
    await run(podman, ["network", "exists", net.name]);
  } catch {
    exists = false;
  }
  if (!exists) {
    await run(podman, [
      "network", "create", "--internal", "--disable-dns", "--subnet", net.subnet, "--gateway", net.gateway,
      "--label", "argus=build-net", net.name,
    ]);
    return "created";
  }
  const { stdout } = await run(podman, ["network", "inspect", net.name]);
  const info = (JSON.parse(stdout) as NetworkInspect[])[0] ?? {};
  const problems = [
    info.internal === true ? "" : "not internal",
    info.dns_enabled === false ? "" : "DNS enabled",
    info.subnets?.some((s) => s.subnet === net.subnet) ? "" : `subnet is not ${net.subnet}`,
  ].filter(Boolean);
  if (problems.length) {
    throw new Error(`network ${net.name} exists but is misconfigured (${problems.join(", ")}); remove it yourself and re-run`);
  }
  return "exists";
}
