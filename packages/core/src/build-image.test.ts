import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BUILD_NETWORK, currentImageTag, ensureBuildNetwork, imageReady, imageTag, podmanBinFromEnv } from "./build-image.ts";

const FAKE_PODMAN = join(import.meta.dirname, "testing", "fake-podman.mjs");
const sources = ["../../../containers/build/Containerfile", "egress-proxy.mjs", "egress-proxy.ts"].map((p) =>
  readFileSync(join(import.meta.dirname, p), "utf8"),
);

describe("podmanBinFromEnv: one variable for the worker and the scripts", () => {
  it("ARGUS_PODMAN_BIN wins, silently, whatever PODMAN says", () => {
    expect(podmanBinFromEnv({ ARGUS_PODMAN_BIN: "/opt/podman" })).toEqual({ bin: "/opt/podman" });
    expect(podmanBinFromEnv({ ARGUS_PODMAN_BIN: "/opt/podman", PODMAN: "/old/podman" })).toEqual({ bin: "/opt/podman" });
  });

  it("the deprecated PODMAN is still honoured, with a warning that names the new variable", () => {
    const r = podmanBinFromEnv({ PODMAN: "/old/podman" });
    expect(r.bin).toBe("/old/podman");
    expect(r.warning).toMatch(/PODMAN is deprecated.*ARGUS_PODMAN_BIN/);
  });

  it("an empty value counts as unset (as .env.example's blank ARGUS_PODMAN_BIN= does), and the default is podman", () => {
    expect(podmanBinFromEnv({ ARGUS_PODMAN_BIN: "", PODMAN: "" })).toEqual({ bin: "podman" });
    expect(podmanBinFromEnv({ ARGUS_PODMAN_BIN: "", PODMAN: "/old/podman" }).bin).toBe("/old/podman");
    expect(podmanBinFromEnv({})).toEqual({ bin: "podman" });
  });
});

describe("imageTag", () => {
  it("derives from the pinned versions and a content hash, never latest", () => {
    const tag = imageTag(sources);
    expect(tag).toMatch(/^localhost\/argus-build:cc2\.1\.318-n22\.23\.4-p11\.2\.2-[0-9a-f]{12}$/);
    expect(tag).not.toContain("latest");
    expect(imageTag(sources)).toBe(tag);
    expect(imageTag([sources[0] + "\n# changed", ...sources.slice(1)])).not.toBe(tag);
  });

  it("currentImageTag gives the tag `pnpm image:build` builds, for the checkout it is pointed at", () => {
    expect(currentImageTag(join(import.meta.dirname, "..", "..", ".."))).toBe(imageTag(sources));
  });

  it("pins the Containerfile to the same versions", () => {
    expect(sources[0]).toContain("pnpm@11.2.2");
    expect(sources[0]).toContain("@anthropic-ai/claude-code@2.1.318");
    expect(sources[0]).toMatch(/^FROM \S+@sha256:[0-9a-f]{64}$/m);
  });
});

describe("with the fake podman", () => {
  let dir: string;
  let log: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "fake-podman-"));
    log = join(dir, "log");
    process.env.FAKE_PODMAN_LOG = log;
  });
  afterEach(() => {
    for (const k of ["FAKE_PODMAN_LOG", "FAKE_PODMAN_IMAGES", "FAKE_PODMAN_NETWORK"]) delete process.env[k];
    rmSync(dir, { recursive: true, force: true });
  });
  const calls = () => {
    try {
      return readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l) as string[]);
    } catch {
      return [];
    }
  };
  const net = (o: object) => JSON.stringify({ internal: true, dns_enabled: false, subnets: [{ subnet: BUILD_NETWORK.subnet }], ...o });

  it("imageReady is false when the tag is absent and true when present", async () => {
    expect(await imageReady("localhost/argus-build:x", FAKE_PODMAN)).toBe(false);
    process.env.FAKE_PODMAN_IMAGES = "other:1,localhost/argus-build:x";
    expect(await imageReady("localhost/argus-build:x", FAKE_PODMAN)).toBe(true);
    expect(calls()[0]).toEqual(["image", "exists", "localhost/argus-build:x"]);
  });

  it("imageReady is false when podman itself is missing", async () => {
    expect(await imageReady("x", join(dir, "no-such-podman"))).toBe(false);
  });

  it("creates the network internal, DNS-less, with the fixed subnet and gateway", async () => {
    expect(await ensureBuildNetwork(FAKE_PODMAN)).toBe("created");
    const create = calls().find((c) => c[1] === "create");
    expect(create).toEqual([
      "network", "create", "--internal", "--disable-dns", "--subnet", "10.89.77.0/24", "--gateway", "10.89.77.1",
      "--label", "argus=build-net", "argus-build-net",
    ]);
  });

  it("accepts a correct existing network whatever its label, without recreating it", async () => {
    process.env.FAKE_PODMAN_NETWORK = net({ labels: { argus: "spike" } });
    expect(await ensureBuildNetwork(FAKE_PODMAN)).toBe("exists");
    expect(calls().some((c) => c[1] === "create")).toBe(false);
  });

  it.each([
    ["not internal", { internal: false }],
    ["DNS enabled", { dns_enabled: true }],
    ["subnet is not", { subnets: [{ subnet: "10.1.0.0/24" }] }],
  ])("refuses a misconfigured network (%s) and does not touch it", async (msg, o) => {
    process.env.FAKE_PODMAN_NETWORK = net(o);
    await expect(ensureBuildNetwork(FAKE_PODMAN)).rejects.toThrow(msg);
    expect(calls().every((c) => c[1] === "exists" || c[1] === "inspect")).toBe(true);
  });
});

// Needs the image from `pnpm image:build`; skipped when it is absent.
const tag = imageTag(sources);
const built = (() => {
  try {
    execFileSync("podman", ["image", "exists", tag]);
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(!built)("the built image", () => {
  const sh = (script: string) =>
    execFileSync("podman", ["run", "--rm", "--pull=never", "--network", "none", "--userns=keep-id", tag, "sh", "-c", script], { encoding: "utf8" });

  it("has only the allowlisted binaries in /usr/local/bin", () => {
    const allowed = ["claude", "corepack", "docker-entrypoint.sh", "node", "nodejs", "npm", "npx", "pn", "pnpm", "pnpx", "pnx", "yarn", "yarnpkg"];
    expect(sh("ls /usr/local/bin").trim().split("\n").sort()).toEqual(allowed);
  });

  it("has none of gh, wrangler, ssh, curl, wget anywhere on PATH", () => {
    const out = sh("for b in gh wrangler ssh curl wget scp sftp; do command -v $b; done; true");
    expect(out.trim()).toBe("");
  });

  it("prints the pinned versions as uid 1000", () => {
    expect(sh("claude --version; pnpm --version; node --version; id -u").trim().split("\n")).toEqual([
      "2.1.318 (Claude Code)", "11.2.2", "v22.23.4", "1000",
    ]);
  });
});
