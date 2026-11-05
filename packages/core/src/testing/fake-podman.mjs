#!/usr/bin/env node
// Fake `podman` for offline tests. Every call's argv is appended to FAKE_PODMAN_LOG (JSON lines).
//   FAKE_PODMAN_IMAGES   comma-separated tags that `image exists` accepts
//   FAKE_PODMAN_NETWORK  JSON of the network `network exists|inspect` sees (absent: no network)
import { appendFileSync } from "node:fs";
import { registerFake } from "./run-registry.mjs";

registerFake();

const argv = process.argv.slice(2);
if (process.env.FAKE_PODMAN_LOG) appendFileSync(process.env.FAKE_PODMAN_LOG, JSON.stringify(argv) + "\n");
const [a, b, c] = argv;
if (a === "image" && b === "exists") process.exit((process.env.FAKE_PODMAN_IMAGES ?? "").split(",").includes(c) ? 0 : 1);
if (a === "network" && b === "exists") process.exit(process.env.FAKE_PODMAN_NETWORK ? 0 : 1);
if (a === "network" && b === "inspect" && process.env.FAKE_PODMAN_NETWORK) {
  console.log(`[${process.env.FAKE_PODMAN_NETWORK}]`);
  process.exit(0);
}
if (a === "network" && b === "create") process.exit(0);
console.error(`fake podman: unsupported ${argv.join(" ")}`);
process.exit(125);
