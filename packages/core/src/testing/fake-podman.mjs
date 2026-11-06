#!/usr/bin/env node
// Fake `podman` for offline tests. Every call's argv is appended to FAKE_PODMAN_LOG (JSON lines, one argv array each); a
// `run` also appends {"envKeys": [...]} (the names, never the values, of the client's own environment) to FAKE_PODMAN_LOG + ".client".
//   FAKE_PODMAN_IMAGES   comma-separated tags that `image exists` accepts
//   FAKE_PODMAN_NETWORK  JSON of the network `network exists|inspect` sees (absent: no network)
//   FAKE_PODMAN_STATE    a directory of JSON files, one per container the fake knows (running, or seeded by a test). Without it
//                        `run` still works but `stop`, `rm`, `ps` and `logs` see nothing.
// `run` models what the real one does that matters to the runner:
//   - the containerised process (`claude ...`, `pnpm install ...`, `wrangler ...`) runs detached in its own process group, with
//     only the environment the `--env` flags give it (plus PATH and FAKE_* variables, which model a test image's baked-in environment),
//     the working directory `-w` names, and values under a `-v host:container` mount mapped back to the host path;
//   - its output reaches the client over pipes, so SIGKILL of the client leaves the container running (only `stop`/`rm` end it);
//     SIGTERM to the client is proxied to the container;
//   - FAKE_PODMAN_RUN_STARTED (a file) is written when the client starts; FAKE_PODMAN_RUN_GATE (a file) holds the creation of the
//     container until it exists: a window in which a `stop` finds nothing to stop;
//   - when the container's main process exits, everything left in its group is killed (the PID namespace is torn down).
//   `run -d` of a sidecar only records state. FAKE_PODMAN_EGRESS_FAIL=1 makes starting a sidecar fail; FAKE_PODMAN_EGRESS_SILENT=1 makes
//   it never log "listening"; FAKE_PODMAN_EGRESS_LOG is extra text `logs` prints (denial lines).
//   FAKE_PODMAN_HANG=stop,rm,logs,run-d makes those subcommands hang, ignoring SIGTERM (see below).
//   In the container: `pnpm install` writes FAKE_PODMAN_INSTALL_FILES (a JSON object of cwd-relative path -> text), or fails with
//   FAKE_PODMAN_INSTALL_FAIL, or hangs (after writing its pid to FAKE_PODMAN_INSTALL_STARTED) with FAKE_PODMAN_INSTALL_HANG; FAKE_PODMAN_INSTALL_LOCKED leaves a mode-000 directory in the cwd; `wrangler` runs FAKE_PODMAN_WRANGLER (default: the fake wrangler beside this file).
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { registerFake, registerPid } from "./run-registry.mjs";

registerFake();

const argv = process.argv.slice(2);
if (process.env.FAKE_PODMAN_LOG) appendFileSync(process.env.FAKE_PODMAN_LOG, JSON.stringify(argv) + "\n");
const [a, b, c] = argv;

const stateDir = process.env.FAKE_PODMAN_STATE;
const statePath = (name) => join(stateDir, `${name}.json`);
const readState = (name) => {
  if (!stateDir || !/^[\w.-]+$/.test(name)) return undefined;
  try {
    return JSON.parse(readFileSync(statePath(name), "utf8"));
  } catch {
    return undefined;
  }
};
const allState = () => {
  if (!stateDir || !existsSync(stateDir)) return [];
  return readdirSync(stateDir).filter((f) => f.endsWith(".json")).map((f) => JSON.parse(readFileSync(join(stateDir, f), "utf8")));
};
const writeState = (s) => {
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(statePath(s.name), JSON.stringify(s));
};
const dropState = (name) => {
  if (stateDir) rmSync(statePath(name), { force: true });
};
const groupAlive = (pgid) => {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
};
const killGroup = (pgid, signal) => {
  try {
    process.kill(-pgid, signal);
  } catch {
    // already gone
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// FAKE_PODMAN_HANG: comma-separated subcommands that hang for good, deaf to SIGTERM (only SIGKILL ends them); "run-d" is `run -d`, the
// sidecar's start. Each hung call appends its pid to FAKE_PODMAN_HANG_PIDS, so a test can show none outlived the run.
if ((process.env.FAKE_PODMAN_HANG ?? "").split(",").includes(a === "run" && argv.includes("-d") ? "run-d" : a)) {
  if (process.env.FAKE_PODMAN_HANG_PIDS) appendFileSync(process.env.FAKE_PODMAN_HANG_PIDS, `${process.pid}\n`);
  process.on("SIGTERM", () => {});
  setInterval(() => {}, 1000);
  await new Promise(() => {});
}

if (a === "--version" || a === "version") {
  console.log("podman version 0.0.0-fake");
  process.exit(0);
}
if (a === "image" && b === "exists") process.exit((process.env.FAKE_PODMAN_IMAGES ?? "").split(",").includes(c) ? 0 : 1);
if (a === "network" && b === "exists") process.exit(process.env.FAKE_PODMAN_NETWORK ? 0 : 1);
if (a === "network" && b === "inspect" && process.env.FAKE_PODMAN_NETWORK) {
  console.log(`[${process.env.FAKE_PODMAN_NETWORK}]`);
  process.exit(0);
}
if (a === "network" && b === "create") process.exit(0);

if (a === "ps") {
  const filter = argv.includes("--filter") ? argv[argv.indexOf("--filter") + 1] : undefined;
  const m = /^label=([^=]+)(?:=(.*))?$/.exec(filter ?? "");
  const rows = allState().filter((s) => !m || (m[1] in (s.labels ?? {}) && (m[2] === undefined || s.labels[m[1]] === m[2])));
  console.log(JSON.stringify(rows.map((s) => ({ Id: s.id ?? s.name, Names: [s.name], Labels: s.labels ?? {}, State: "running" }))));
  process.exit(0);
}

if (a === "stop" || a === "rm") {
  const name = argv.at(-1);
  const t = argv.includes("-t") ? Number(argv[argv.indexOf("-t") + 1]) : 10;
  const s = readState(name);
  if (!s) process.exit(argv.includes("--ignore") ? 0 : 125);
  if (s.pgid) {
    if (a === "stop") {
      killGroup(s.pgid, "SIGTERM");
      for (const end = Date.now() + t * 1000; groupAlive(s.pgid) && Date.now() < end; ) await sleep(20);
    }
    killGroup(s.pgid, "SIGKILL");
    for (const end = Date.now() + 5000; groupAlive(s.pgid) && Date.now() < end; ) await sleep(10);
  }
  // `stop` leaves a container that was not started with --rm; every container the runner starts is, so it is gone here too.
  dropState(name);
  process.exit(0);
}

if (a === "logs") {
  const s = readState(argv.at(-1));
  if (!s) {
    console.error("Error: no such container");
    process.exit(125);
  }
  if (s.kind === "sidecar" && !process.env.FAKE_PODMAN_EGRESS_SILENT) console.log(JSON.stringify({ event: "listening", port: 3128, allow: s.allow ?? [] }));
  if (s.kind === "sidecar" && process.env.FAKE_PODMAN_EGRESS_LOG) console.log(process.env.FAKE_PODMAN_EGRESS_LOG);
  process.exit(0);
}

if (a === "run") {
  const VALUE_FLAGS = new Set(["--name", "--label", "--env", "-e", "-v", "-w", "--network", "--tmpfs", "--timeout", "--pids-limit", "--memory", "--cpus", "--security-opt", "--userns", "--log-driver", "--pull", "--cap-drop"]);
  const flags = { env: [], mounts: [], labels: {}, networks: [] };
  let i = 1;
  for (; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("-")) break;
    let name = arg;
    let value;
    if (arg.startsWith("--") && arg.includes("=")) {
      name = arg.slice(0, arg.indexOf("="));
      value = arg.slice(arg.indexOf("=") + 1);
    } else if (VALUE_FLAGS.has(arg)) {
      value = argv[++i];
    } else {
      flags[arg] = true;
      continue;
    }
    if (name === "--env" || name === "-e") flags.env.push(value);
    else if (name === "-v") flags.mounts.push(value);
    else if (name === "--network") flags.networks.push(value);
    else if (name === "--label") {
      const eq = value.indexOf("=");
      flags.labels[value.slice(0, eq)] = value.slice(eq + 1);
    } else flags[name] = value;
  }
  const image = argv[i];
  const command = argv.slice(i + 1);
  if (process.env.FAKE_PODMAN_LOG) appendFileSync(`${process.env.FAKE_PODMAN_LOG}.client`, JSON.stringify({ envKeys: Object.keys(process.env) }) + "\n");
  const name = flags["--name"];

  if (flags["-d"]) {
    if (process.env.FAKE_PODMAN_EGRESS_FAIL) {
      console.error("Error: IPAM error: requested ip address is already allocated (fake)");
      process.exit(126);
    }
    const allow = flags.env.map((e) => /^ARGUS_EGRESS_ALLOW=(.*)$/.exec(e)?.[1]).find((v) => v !== undefined)?.split(",") ?? [];
    if (readState(name)) {
      console.error(`Error: name ${name} is already in use`);
      process.exit(125);
    }
    writeState({ name, id: `fake-${name}`, kind: "sidecar", labels: flags.labels, allow, image, networks: flags.networks, command });
    console.log(`fake-${name}`);
    process.exit(0);
  }

  // The containerised environment: what --env gives it, mount destinations mapped back to host paths, and the test image's own variables.
  const maps = flags.mounts.map((m) => m.split(":")).filter((p) => p[0] !== p[1]);
  const mapPath = (v) => maps.reduce((acc, [src, dst]) => (acc === dst || acc.startsWith(`${dst}/`) ? src + acc.slice(dst.length) : acc), v);
  const env = { PATH: process.env.PATH };
  for (const [k, v] of Object.entries(process.env)) if (k.startsWith("FAKE_")) env[k] = v;
  for (const e of flags.env) {
    const eq = e.indexOf("=");
    if (eq < 0) {
      if (process.env[e] !== undefined) env[e] = process.env[e];
    } else env[e.slice(0, eq)] = mapPath(e.slice(eq + 1));
  }
  // An explicit PATH (the bundle's) goes in front of the host's, which the fake needs to find node.
  if (env.PATH !== process.env.PATH) env.PATH = `${env.PATH}:${process.env.PATH}`;
  const cwd = flags["-w"] ? mapPath(flags["-w"]) : process.cwd();

  let program;
  let args;
  const here = import.meta.dirname;
  if (command[0] === "claude") {
    program = join(here, "fake-claude.mjs");
    args = command.slice(1);
  } else if (command[0] === "wrangler") {
    program = process.env.FAKE_PODMAN_WRANGLER || join(here, "fake-wrangler.mjs");
    args = command.slice(1);
  } else if (command[0] === "pnpm" && command[1] === "install") {
    program = process.execPath;
    args = [
      "-e",
      `const fs = require("node:fs"), path = require("node:path");
       if (process.env.FAKE_PODMAN_INSTALL_FAIL) { console.error("ERR_PNPM_OUTDATED_LOCKFILE (fake)"); process.exit(1); }
       if (process.env.FAKE_PODMAN_INSTALL_HANG) {
         if (process.env.FAKE_PODMAN_INSTALL_STARTED) fs.writeFileSync(process.env.FAKE_PODMAN_INSTALL_STARTED, String(process.pid));
         setInterval(() => {}, 1000);
       } else {
         for (const [f, text] of Object.entries(JSON.parse(process.env.FAKE_PODMAN_INSTALL_FILES ?? "{}"))) { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); }
         // A package's install script can leave a directory nobody can enter (mode 000), which a plain recursive remove cannot clear.
         if (process.env.FAKE_PODMAN_INSTALL_LOCKED) { fs.mkdirSync("locked/inner", { recursive: true }); fs.writeFileSync("locked/inner/f", "x"); fs.chmodSync("locked/inner", 0); fs.chmodSync("locked", 0); }
       }`,
    ];
  } else {
    console.error(`fake podman: unsupported container command ${command.join(" ")}`);
    process.exit(125);
  }

  // --sig-proxy: SIGTERM and SIGINT reach the container; SIGKILL cannot be caught, so it never does. A signal that arrives while the
  // container is still being created has nothing to reach, and the client carries on creating it.
  let child;
  for (const sig of ["SIGTERM", "SIGINT"]) process.on(sig, () => child && killGroup(child.pid, sig));
  // Creating the container takes time that a test can hold open: the client says it has started, then waits for the gate file.
  if (process.env.FAKE_PODMAN_RUN_STARTED) writeFileSync(process.env.FAKE_PODMAN_RUN_STARTED, String(process.pid));
  while (process.env.FAKE_PODMAN_RUN_GATE && !existsSync(process.env.FAKE_PODMAN_RUN_GATE)) await sleep(10);

  child = spawn(program, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"], detached: true });
  registerPid(child.pid);
  if (name) writeState({ name, id: `fake-${name}`, kind: "build", labels: flags.labels, pgid: child.pid, image });
  child.stdout.pipe(process.stdout, { end: false });
  child.stderr.pipe(process.stderr, { end: false });
  child.on("error", (e) => {
    console.error(`fake podman: ${e.message}`);
    if (name) dropState(name);
    process.exit(126);
  });
  child.on("close", (code, signal) => {
    // The PID namespace goes with the container's first process: nothing it started survives it.
    killGroup(child.pid, "SIGKILL");
    if (name) dropState(name);
    process.exit(code ?? (signal ? 128 + ({ SIGTERM: 15, SIGKILL: 9, SIGINT: 2 }[signal] ?? 1) : 1));
  });
} else {
  console.error(`fake podman: unsupported ${argv.join(" ")}`);
  process.exit(125);
}
