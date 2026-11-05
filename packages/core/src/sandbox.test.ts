import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { killLiveBrainChildren } from "./brain.ts";
import { buildHomeFor, buildLogPathFor, runNextBuild } from "./build-runner.ts";
import {
  DEFAULT_CAPS,
  PodmanSandbox,
  buildPodmanRunArgs,
  capsFromEnv,
  containerEnv,
  dataIdFor,
  egressRunArgs,
  readBuildToken,
  resumeCommand,
  type ContainerRole,
  type SandboxJob,
} from "./sandbox.ts";
import { makeHarness, TEST_IMAGE, TEST_TOKEN, type Harness } from "./testing/build-harness.ts";
import { tempPath } from "./testing/temp.ts";
import { untilExists } from "./testing/wait.ts";

const NAME = "argus-build-7-0123abcd";

/** A job with distinctive paths, so a mount or env var that appears from nowhere is easy to see. */
const job = (role: ContainerRole, over: Partial<SandboxJob> = {}): SandboxJob => ({
  role,
  buildId: 7,
  cwd: "/work/repo",
  mounts: ["/work/repo"],
  home: "/data/proposals/7/home",
  args: ["--some", "arg"],
  timeoutMs: 600_000,
  ...over,
});
const OWNERSHIP = { dataId: "0123456789ab", owner: "4242.99" };
const argvFor = (role: ContainerRole, over: Partial<SandboxJob> = {}) =>
  buildPodmanRunArgs({ job: job(role, { ...(role === "bundle" ? { binDir: BIN_DIR } : {}), ...over }), name: role === "agent" ? NAME : `argus-${role}-7-0123abcd`, image: TEST_IMAGE, caps: DEFAULT_CAPS, ownership: OWNERSHIP });

/** The values of every occurrence of a flag (`--env X`, `-v X`, `--label X`). */
const flagValues = (argv: string[], flag: string) => argv.flatMap((a, i) => (a === flag ? [argv[i + 1]!] : []));

// The allowlists. They are written out here, not derived from the module: adding a mount or an environment variable to a container
// fails these tests until the list below, and the reviewer reading this diff, say so.
const ALLOWED_ENV: Record<ContainerRole, string[]> = {
  agent: [
    "HOME=/home/agent",
    "CLAUDE_CONFIG_DIR=/home/agent/.claude",
    "CLAUDE_CODE_DISABLE_CLAUDE_MDS=1",
    "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1",
    "DISABLE_AUTOUPDATER=1",
    "HTTPS_PROXY=http://10.89.77.2:3128",
    "https_proxy=http://10.89.77.2:3128",
    "NO_PROXY=",
    "GIT_AUTHOR_NAME=argus",
    "GIT_AUTHOR_EMAIL=argus@localhost",
    "GIT_COMMITTER_NAME=argus",
    "GIT_COMMITTER_EMAIL=argus@localhost",
    "GIT_CONFIG_GLOBAL=/dev/null",
    "GIT_CONFIG_SYSTEM=/dev/null",
    "CI=1",
    "CLAUDE_CODE_OAUTH_TOKEN", // no value: podman reads it from its own environment
  ],
  install: ["HOME=/home/agent", "HTTPS_PROXY=http://10.89.77.2:3128", "https_proxy=http://10.89.77.2:3128", "NO_PROXY=", "CI=1"],
  bundle: ["HOME=/home/agent", "PATH=/seal/work/export/node_modules/.bin:/usr/local/bin:/usr/local/sbin:/usr/sbin:/usr/bin:/sbin:/bin", "CI=1", "WRANGLER_SEND_METRICS=false"],
};
const BIN_DIR = "/seal/work/export/node_modules/.bin";

describe("buildPodmanRunArgs: the container's policy", () => {
  it.each(["agent", "install", "bundle"] as const)("%s: carries every hardening flag and none of the dangerous ones", (role) => {
    const argv = argvFor(role);
    const text = argv.join(" ");
    for (const required of ["run", "--rm", "--pull=never", "--init", "--log-driver=none", "--userns=keep-id", "--cap-drop=all", "--read-only", "--pids-limit=1024", "--memory=8g", "--cpus=4"]) {
      expect(argv, required).toContain(required);
    }
    expect(flagValues(argv, "--security-opt")).toEqual(["no-new-privileges"]);
    // Every place a container can write besides the repo and home is a tmpfs that cannot execute: the engine's own writable
    // tmpfs dirs (/var/tmp, /run) would otherwise be rw without noexec.
    expect(flagValues(argv, "--tmpfs")).toEqual(["/tmp:rw,noexec,nosuid,nodev,size=2g", "/var/tmp:rw,noexec,nosuid,nodev,size=2g", "/run:rw,noexec,nosuid,nodev,size=64m"]);
    // The conmon backstop: the caller's cap plus a minute.
    expect(argv).toContain("--timeout=660");
    expect(flagValues(argv, "--label")).toEqual(["argus.build=7", `argus.role=${role}`, "argus.data=0123456789ab", "argus.owner=4242.99"]);
    for (const forbidden of ["--privileged", "--network host", "--network=host", "--env-host", "--device", "--cap-add", "--pid=", "--ipc", "--uts", "label=disable", "--userns=host", "--mount", "ANTHROPIC_API_KEY", "GH_TOKEN", "GITHUB_TOKEN", "CLOUDFLARE", "docker.sock", "podman.sock"]) {
      expect(text, forbidden).not.toContain(forbidden);
    }
    expect(argv).not.toContain("--pid"); // (--pids-limit is wanted, a bare --pid is a namespace choice)
  });

  it("agent and install join only the internal network, the bundle has no network at all", () => {
    expect(flagValues(argvFor("agent"), "--network")).toEqual(["argus-build-net"]);
    expect(flagValues(argvFor("install"), "--network")).toEqual(["argus-build-net"]);
    expect(flagValues(argvFor("bundle"), "--network")).toEqual(["none"]);
  });

  it.each(["agent", "install", "bundle"] as const)("%s: its environment is exactly the allowlist", (role) => {
    expect(flagValues(argvFor(role), "--env")).toEqual(ALLOWED_ENV[role]);
    expect(containerEnv(role, BIN_DIR).map(([k, v]) => (v === undefined ? k : `${k}=${v}`))).toEqual(ALLOWED_ENV[role]);
  });

  it("the Build token is passed by name only, so it is never on a command line", () => {
    const envFlags = flagValues(argvFor("agent"), "--env");
    expect(envFlags).toContain("CLAUDE_CODE_OAUTH_TOKEN");
    expect(envFlags.filter((e) => e.startsWith("CLAUDE_CODE_OAUTH_TOKEN="))).toEqual([]);
    expect(flagValues(argvFor("install"), "--env").some((e) => e.includes("OAUTH"))).toBe(false);
    expect(flagValues(argvFor("bundle"), "--env").some((e) => e.includes("OAUTH"))).toBe(false);
  });

  it("mounts exactly the job's directories at the same path, and the home at /home/agent, each relabelled privately (:Z)", () => {
    expect(flagValues(argvFor("agent"), "-v")).toEqual(["/work/repo:/work/repo:Z", "/data/proposals/7/home:/home/agent:Z"]);
    expect(flagValues(argvFor("agent"), "-w")).toEqual(["/work/repo"]);
    const bundle = argvFor("bundle", { cwd: "/seal/work", mounts: ["/seal/work"], home: "/seal/home" });
    expect(flagValues(bundle, "-v")).toEqual(["/seal/work:/seal/work:Z", "/seal/home:/home/agent:Z"]);
  });

  it("refuses a mount that is not an absolute, normalised path or that could smuggle mount options", () => {
    for (const bad of ["relative/dir", "/", "/a/../b", "/a:/etc:ro", "/a,b", "/a\nb"]) {
      expect(() => argvFor("agent", { mounts: [bad] }), bad).toThrow(/refusing to mount/);
      expect(() => argvFor("agent", { home: bad }), bad).toThrow(/refusing to mount/);
    }
  });

  it("runs the role's program after the image, with the job's args last and untouched", () => {
    const tail = (role: ContainerRole) => {
      const a = argvFor(role);
      return a.slice(a.indexOf(TEST_IMAGE) + 1);
    };
    expect(tail("agent")).toEqual(["claude", "--some", "arg"]);
    expect(tail("install")).toEqual(["pnpm", "install", "--frozen-lockfile", "--some", "arg"]);
    expect(tail("bundle")).toEqual(["wrangler", "deploy", "--some", "arg"]);
  });

  it("applies the caps it is given", () => {
    const argv = buildPodmanRunArgs({ job: job("agent"), name: NAME, image: TEST_IMAGE, caps: { memoryGiB: 2, cpus: 1.5, pids: 99, tmpGiB: 1 }, ownership: OWNERSHIP });
    expect(argv).toEqual(expect.arrayContaining(["--pids-limit=99", "--memory=2g", "--cpus=1.5"]));
    expect(flagValues(argv, "--tmpfs")).toEqual(["/tmp:rw,noexec,nosuid,nodev,size=1g", "/var/tmp:rw,noexec,nosuid,nodev,size=1g", "/run:rw,noexec,nosuid,nodev,size=64m"]);
  });

  it("refuses a container name that is not argus's", () => {
    for (const bad of ["x", "argus-build-7", "argus-build-7-XYZ", "argus-build-7-0123abcd --privileged"]) {
      expect(() => buildPodmanRunArgs({ job: job("agent"), name: bad, image: TEST_IMAGE, caps: DEFAULT_CAPS, ownership: OWNERSHIP })).toThrow(/bad container name/);
    }
  });
});

describe("the egress sidecar's argv", () => {
  it("is dual-homed, unprivileged, mounts nothing, and its only env is the allowlist", () => {
    const argv = egressRunArgs({ name: "argus-egress-7-0123abcd", buildId: 7, image: TEST_IMAGE, ownership: OWNERSHIP });
    expect(flagValues(argv, "--network")).toEqual(["argus-build-net:ip=10.89.77.2", "podman"]);
    expect(argv).toEqual(expect.arrayContaining(["--rm", "-d", "--pull=never", "--cap-drop=all", "--read-only", "--userns=keep-id"]));
    expect(flagValues(argv, "--security-opt")).toEqual(["no-new-privileges"]);
    expect(flagValues(argv, "-v")).toEqual([]);
    expect(flagValues(argv, "--env")).toEqual(["ARGUS_EGRESS_ALLOW=api.anthropic.com:443,registry.npmjs.org:443"]);
    expect(flagValues(argv, "--label")).toEqual(["argus.build=7", "argus.role=egress", "argus.data=0123456789ab", "argus.owner=4242.99"]);
    expect(argv.slice(argv.indexOf(TEST_IMAGE) + 1)).toEqual(["node", "/opt/argus/egress-proxy.mjs"]);
    expect(argv.join(" ")).not.toContain("--privileged");
  });
});

describe("small pieces", () => {
  it("resumeCommand prints the exact command the Operator runs on the host, and refuses anything that is not a session id", () => {
    const sessionId = "5e55a0a0-0000-4000-8000-000000000001";
    expect(resumeCommand({ repo: "/home/u/code/cat-coin", home: "/home/u/argus/.data/proposals/7/home", sessionId })).toBe(
      "cd /home/u/code/cat-coin && CLAUDE_CONFIG_DIR=/home/u/argus/.data/proposals/7/home/.claude claude --resume 5e55a0a0-0000-4000-8000-000000000001",
    );
    expect(resumeCommand({ repo: "/home/u/my code", home: "/h", sessionId })).toContain("cd '/home/u/my code' &&");
    expect(() => resumeCommand({ repo: "/r", home: "/h", sessionId: "x; rm -rf ~" })).toThrow();
  });

  it("capsFromEnv defaults to the Operator's caps and rejects a value that is not a positive number", () => {
    expect(capsFromEnv({})).toEqual({ memoryGiB: 8, cpus: 4, pids: 1024, tmpGiB: 2 });
    expect(capsFromEnv({ ARGUS_BUILD_MEMORY_GIB: "4", ARGUS_BUILD_PIDS: "512" })).toMatchObject({ memoryGiB: 4, pids: 512 });
    for (const bad of ["0", "-1", "lots", "NaN"]) expect(() => capsFromEnv({ ARGUS_BUILD_CPUS: bad })).toThrow(/ARGUS_BUILD_CPUS/);
  });

  it("PodmanSandbox only accepts a pinned image tag", () => {
    const mk = (image: string) => new PodmanSandbox({ image, tokenPath: "/nowhere", dataDir: "/nowhere" });
    expect(() => mk("localhost/argus-build:latest")).toThrow(/pinned/);
    expect(() => mk("localhost/argus-build")).toThrow(/pinned/);
    expect(() => mk("localhost/argus-build:cc2.1.318-n22.23.4-p11.2.2-1a2322f33ee5")).not.toThrow();
  });

  it("readBuildToken reads a private one-line file, and its errors never contain the token", () => {
    const h = makeHarness();
    expect(readBuildToken(h.tokenPath)).toBe(TEST_TOKEN);
    chmodSync(h.tokenPath, 0o644);
    expect(() => readBuildToken(h.tokenPath)).toThrow(/readable by others/);
    writeFileSync(h.tokenPath, `${TEST_TOKEN}\nsecond line\n`, { mode: 0o600 });
    chmodSync(h.tokenPath, 0o600);
    let message = "";
    try {
      readBuildToken(h.tokenPath);
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain("more than one line");
    expect(message).not.toContain(TEST_TOKEN);
    expect(() => readBuildToken(join(h.root, "missing"))).toThrow(/does not exist/);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
// Behaviour over the fake podman.

async function runBuild(h: Harness, signal?: AbortSignal) {
  const p = h.seedApproved("Cat Coin");
  const outcome = await runNextBuild(h.store, h.brain, h.options, signal);
  const reason = h.store.historyFor(p.id).at(-1)!.reason;
  return { p, outcome, after: h.store.getProposal(p.id)!, reason };
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const realSetTimeout = globalThis.setTimeout;
const untilDead = async (pid: number, deadlineMs = 20_000) => {
  const end = Date.now() + deadlineMs;
  while (alive(pid) && Date.now() < end) await new Promise((r) => realSetTimeout(r, 10));
  expect(alive(pid)).toBe(false);
};

/** The index of the first call matching `argv` (a prefix), or -1. */
const at = (calls: string[][], ...prefix: string[]) => calls.findIndex((c) => prefix.every((p, i) => c[i] === p));
const names = (calls: string[][]) => calls.filter((c) => c[0] === "run").map((c) => c[c.indexOf("--name") + 1]!);

// Each test runs whole Builds: git, a container's worth of fake processes, a bundle and a deploy. Under load that is not 5 s.
describe("a Build runs its claude in a container", { timeout: 60_000 }, () => {
  it("passes the claude argv, budget and timeout through byte for byte, and starts the sidecar first", async () => {
    const h = makeHarness();
    const r = await runBuild(h);
    expect(r.after.status).toBe("built");
    const calls = h.podmanCalls();
    const agentRun = calls.find((c) => c[0] === "run" && !c.includes("-d") && flagValues(c, "--label").includes("argus.role=agent"))!;
    const expected = h.brain.buildArgs("build", { prompt: String(r.p.id), slash: "implement-spec" });
    expect(agentRun.slice(agentRun.indexOf(TEST_IMAGE) + 1)).toEqual(["claude", ...expected]);
    expect(expected[expected.indexOf("--max-budget-usd") + 1]).toBe("25");
    expect(agentRun).toContain(`--timeout=${240 * 60 + 60}`); // the route's 4 h plus the conmon minute
    // The sidecar is running (and listening) before the Build container starts.
    const sidecar = calls.findIndex((c) => c[0] === "run" && c.includes("-d"));
    expect(sidecar).toBeGreaterThanOrEqual(0);
    expect(sidecar).toBeLessThan(calls.indexOf(agentRun));
    expect(at(calls, "logs")).toBeGreaterThan(sidecar);
  });

  it("gives the container only what the allowlist says: its env, a per-Build home, and not a single host secret", async () => {
    const h = makeHarness();
    const r = await runBuild(h);
    expect(r.after.status).toBe("built");
    const [claude] = h.calls(h.claudeLog);
    const home = buildHomeFor(h.dataDir, r.p.id);
    expect(claude!.env.CLAUDE_CODE_OAUTH_TOKEN).toBe(TEST_TOKEN); // passed through by name
    expect(claude!.env.HOME).toBe(home); // /home/agent, mapped back to the host path by the fake
    expect(claude!.env.CLAUDE_CONFIG_DIR).toBe(`${home}/.claude`);
    expect(claude!.env.HTTPS_PROXY).toBe("http://10.89.77.2:3128");
    expect(claude!.env.GIT_AUTHOR_EMAIL).toBe("argus@localhost");
    expect(claude!.env.CLAUDE_CODE_DISABLE_CLAUDE_MDS).toBe("1");
    for (const secret of ["ANTHROPIC_API_KEY", "CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID", "GH_TOKEN", "GITHUB_TOKEN"]) expect(claude!.env[secret], secret).toBeUndefined();

    // The podman client itself: PATH, HOME, XDG_RUNTIME_DIR, the test switches, and the token only for the agent's run.
    const clients = readFileSync(`${h.podmanLog}.client`, "utf8").trim().split("\n").map((l) => (JSON.parse(l) as { envKeys: string[] }).envKeys);
    for (const keys of clients) {
      const extra = keys.filter((k) => !["PATH", "HOME", "XDG_RUNTIME_DIR", "CLAUDE_CODE_OAUTH_TOKEN"].includes(k) && !k.startsWith("FAKE_"));
      expect(extra).toEqual([]);
    }
    expect(clients.filter((keys) => keys.includes("CLAUDE_CODE_OAUTH_TOKEN"))).toHaveLength(1);

    // The token is on no command line and in no log.
    expect(JSON.stringify(h.podmanCalls())).not.toContain(TEST_TOKEN);
    expect(readFileSync(buildLogPathFor(h.dataDir, r.p.id), "utf8")).not.toContain(TEST_TOKEN);
    expect(h.logs.join("\n")).not.toContain(TEST_TOKEN);
  });

  it("keeps the per-Build home of a failed Build (it holds the session to resume) and removes that of a built one", async () => {
    const failed = makeHarness({ claudeEnv: { FAKE_CLAUDE_MODE: "failure" } });
    const f = await runBuild(failed);
    expect(f.after.status).toBe("build-failed");
    expect(existsSync(buildHomeFor(failed.dataDir, f.p.id))).toBe(true);

    const built = makeHarness();
    const b = await runBuild(built);
    expect(b.after.status).toBe("built");
    expect(existsSync(buildHomeFor(built.dataDir, b.p.id))).toBe(false);
    // The seal (with the dependency install in it) is gone on both paths: only the home may remain under the Proposal's directory.
    expect(readdirSync(join(built.dataDir, "proposals", String(b.p.id))).filter((n) => n.startsWith("seal-"))).toEqual([]);
    expect(readdirSync(join(failed.dataDir, "proposals", String(f.p.id))).filter((n) => n.startsWith("seal-"))).toEqual([]);
  });

  it("puts what the sidecar refused into the Build log", async () => {
    const denied = JSON.stringify({ event: "denied", reason: "not-allowlisted", status: 403, target: "evil.example:443" });
    const h = makeHarness({ podmanEnv: { FAKE_PODMAN_EGRESS_LOG: denied } });
    const r = await runBuild(h);
    expect(r.after.status).toBe("built");
    expect(readFileSync(buildLogPathFor(h.dataDir, r.p.id), "utf8")).toContain("# argus: argus-egress: denied evil.example:443 (not-allowlisted)");
  });

  it("fails the Build, running no claude and leaving nothing behind, when the sidecar cannot start", async () => {
    const h = makeHarness({ podmanEnv: { FAKE_PODMAN_EGRESS_FAIL: "1" } });
    const r = await runBuild(h);
    expect(r.after.status).toBe("build-failed");
    expect(r.reason).toContain("egress proxy sidecar could not be started");
    expect(h.calls(h.claudeLog)).toEqual([]);
    expect(h.containers()).toEqual([]);
    expect(h.store.brainRunsFor(r.p.id)).toMatchObject([{ exitStatus: "failed" }]);
  });

  it("fails the Build and removes the sidecar when it never reports listening", async () => {
    const h = makeHarness({ podmanEnv: { FAKE_PODMAN_EGRESS_SILENT: "1" } });
    h.options.sandbox = h.makeSandbox({ egressWaitMs: 300 });
    const r = await runBuild(h);
    expect(r.after.status).toBe("build-failed");
    expect(r.reason).toContain("did not report listening");
    expect(h.calls(h.claudeLog)).toEqual([]);
    expect(h.containers()).toEqual([]);
  });
});

describe("timeout, abort and shutdown each stop the container, then remove it, and leave nothing", { timeout: 60_000 }, () => {
  const stubborn = (extra: Record<string, string> = {}) => ({ FAKE_CLAUDE_MODE: "hang-stubborn", ...extra });

  /** The container and sidecar the Build started: stop came before rm -f for each, and the sidecar outlived the Build container. */
  function expectEnded(h: Harness) {
    const calls = h.podmanCalls();
    const [container, sidecar] = [names(calls).find((n) => n.startsWith("argus-build-"))!, names(calls).find((n) => n.startsWith("argus-egress-"))!];
    expect(container).toBeDefined();
    expect(sidecar).toBeDefined();
    for (const n of [container, sidecar]) {
      const stop = at(calls, "stop", "--ignore", "-t", "1", n);
      const rm = at(calls, "rm", "-f", "--ignore", n);
      expect(stop, `stop ${n}`).toBeGreaterThanOrEqual(0);
      expect(rm, `rm ${n}`).toBeGreaterThan(stop);
    }
    expect(at(calls, "rm", "-f", "--ignore", sidecar)).toBeGreaterThan(at(calls, "stop", "--ignore", "-t", "1", container));
    expect(h.containers()).toEqual([]);
  }

  it("timeout: the wall-clock cap ends the container even though claude ignores SIGTERM, and the grandchild dies with it", async () => {
    const grandchild = tempPath("sandbox-gc");
    const h = makeHarness({ claudeEnv: stubborn({ FAKE_CLAUDE_GRANDCHILD: grandchild }), routing: { build: { timeoutMs: 1500 } } });
    const r = await runBuild(h);
    expect(r.after.status).toBe("build-failed");
    expect(r.reason).toContain("timed-out");
    expectEnded(h);
    await untilDead(Number(readFileSync(grandchild, "utf8")));
    expect(alive(h.calls(h.claudeLog)[0]!.pid)).toBe(false);
    rmSync(grandchild, { force: true });
  });

  it("abort: the worker's signal ends the container and the Build is recorded as interrupted", async () => {
    const h = makeHarness({ claudeEnv: stubborn() });
    const ac = new AbortController();
    const p = h.seedApproved("Cat Coin");
    const running = runNextBuild(h.store, h.brain, h.options, ac.signal);
    await untilExists(h.started);
    ac.abort();
    expect(await running).toEqual({ proposalId: p.id, result: "build-failed" });
    expect(h.store.brainRunsFor(p.id)).toMatchObject([{ exitStatus: "interrupted" }]);
    expectEnded(h);
    expect(alive(h.calls(h.claudeLog)[0]!.pid)).toBe(false);
  });

  it("shutdown: killLiveBrainChildren ends the container too", async () => {
    const h = makeHarness({ claudeEnv: stubborn() });
    const p = h.seedApproved("Cat Coin");
    const running = runNextBuild(h.store, h.brain, h.options);
    await untilExists(h.started);
    expect(await killLiveBrainChildren(200)).toBe(1);
    expect(await running).toEqual({ proposalId: p.id, result: "build-failed" });
    expect(h.store.brainRunsFor(p.id)).toMatchObject([{ exitStatus: "interrupted" }]);
    expectEnded(h);
    expect(alive(h.calls(h.claudeLog)[0]!.pid)).toBe(false);
  });

  it("abort during the dependency install ends that container and its sidecar as well", async () => {
    const started = tempPath("sandbox-install");
    const h = makeHarness({ podmanEnv: { FAKE_PODMAN_INSTALL_HANG: "1", FAKE_PODMAN_INSTALL_STARTED: started } });
    const ac = new AbortController();
    const p = h.seedApproved("Cat Coin");
    const running = runNextBuild(h.store, h.brain, h.options, ac.signal);
    await untilExists(started);
    ac.abort();
    expect(await running).toEqual({ proposalId: p.id, result: "build-failed" });
    const calls = h.podmanCalls();
    const install = names(calls).find((n) => n.startsWith("argus-install-"))!;
    const egress = names(calls).filter((n) => n.startsWith("argus-egress-")).at(-1)!; // the install's, after the agent's
    for (const n of [install, egress]) expect(at(calls, "rm", "-f", "--ignore", n), n).toBeGreaterThan(at(calls, "stop", "--ignore", "-t", "1", n));
    expect(h.containers()).toEqual([]);
    expect(names(calls).some((n) => n.startsWith("argus-bundle-"))).toBe(false); // never reached the bundle
    rmSync(started, { force: true });
  });
});

describe("startup reconciliation", { timeout: 30_000 }, () => {
  const seed = (h: Harness, name: string, labels: Record<string, string>, pgid?: number) => {
    mkdirSync(h.podmanState, { recursive: true });
    writeFileSync(join(h.podmanState, `${name}.json`), JSON.stringify({ name, id: `id-${name}`, labels, ...(pgid ? { pgid } : {}) }));
  };

  it("stops and removes labelled leftovers of a dead worker, and never touches an unrelated container (owners are covered in sandbox-lifecycle.test.ts)", async () => {
    const h = makeHarness();
    const dead = { "argus.data": dataIdFor(h.dataDir), "argus.owner": "999999999.5" }; // a pid that does not exist
    seed(h, "argus-build-7-0123abcd", { "argus.build": "7", "argus.role": "agent", ...dead });
    seed(h, "argus-egress-7-0123abcd", { "argus.build": "7", "argus.role": "egress", ...dead });
    seed(h, "supabase_db_workers", { "com.docker.compose.project": "supabase" });
    seed(h, "argus-build-9-feedface", {}); // our name but no label: not ours to touch
    seed(h, "my-own-thing", { "argus.build": "1" }); // our label but not our name: not ours either
    const lines: string[] = [];
    const removed = await h.sandbox.reconcile((l) => lines.push(l));
    expect(removed.sort()).toEqual(["argus-build-7-0123abcd", "argus-egress-7-0123abcd"]);
    expect(h.containers()).toEqual(["argus-build-9-feedface", "my-own-thing", "supabase_db_workers"]);
    const calls = h.podmanCalls();
    expect(calls.filter((c) => c[0] === "ps")).toEqual([["ps", "-a", "--filter", "label=argus.build", "--format", "json"]]);
    for (const c of calls.filter((c) => c[0] === "stop" || c[0] === "rm")) expect(["argus-build-7-0123abcd", "argus-egress-7-0123abcd"]).toContain(c.at(-1));
    expect(at(calls, "rm", "-f", "--ignore", "argus-build-7-0123abcd")).toBeGreaterThan(at(calls, "stop", "--ignore", "-t", "1", "argus-build-7-0123abcd"));
    expect(lines.join("\n")).toContain("removed leftover Build container argus-build-7-0123abcd");
  });

  it("does nothing, and says so, when podman cannot list containers", async () => {
    const h = makeHarness();
    h.options.sandbox = h.makeSandbox({ podmanBin: join(h.root, "no-such-podman") });
    const lines: string[] = [];
    expect(await h.options.sandbox.reconcile((l) => lines.push(l))).toEqual([]);
    expect(lines.join("\n")).toContain("could not list leftover Build containers");
  });
});

describe("preflight: a Build that cannot be contained does not start", { timeout: 60_000 }, () => {
  const logged = (h: Harness) => h.logs.filter((l) => l.includes("not started"));

  async function refused(h: Harness, expectLine: RegExp) {
    const p = h.seedApproved("Cat Coin");
    expect(await runNextBuild(h.store, h.brain, h.options)).toBeUndefined();
    expect(await runNextBuild(h.store, h.brain, h.options)).toBeUndefined(); // the next tick: same answer, one log line
    expect(h.store.getProposal(p.id)!.status).toBe("approved");
    expect(h.store.brainRunsFor(p.id)).toEqual([]);
    expect(h.calls(h.claudeLog)).toEqual([]);
    expect(h.calls(h.ghLog)).toEqual([]);
    expect(existsSync(h.repoDir("cat-coin"))).toBe(false);
    expect(logged(h)).toHaveLength(1);
    expect(logged(h)[0]).toMatch(expectLine);
    expect(logged(h)[0]).toContain("stays approved");
    expect(h.containers()).toEqual([]);
    // It builds once the cause is gone.
    return p;
  }

  it("a missing image: the log line says to run pnpm image:build, and the Build starts once the image is there", async () => {
    const h = makeHarness();
    h.sandboxEnv.FAKE_PODMAN_IMAGES = "";
    const p = await refused(h, /Build image localhost\/argus-build:test-0123456789ab is not present; run `pnpm image:build`/);
    h.sandboxEnv.FAKE_PODMAN_IMAGES = TEST_IMAGE;
    expect(await runNextBuild(h.store, h.brain, h.options)).toEqual({ proposalId: p.id, result: "built" });
  });

  it("a missing podman", async () => {
    const h = makeHarness();
    h.options.sandbox = h.makeSandbox({ podmanBin: join(h.root, "no-such-podman") });
    await refused(h, /podman is not available/);
  });

  it("a missing network", async () => {
    const h = makeHarness();
    h.sandboxEnv.FAKE_PODMAN_NETWORK = "";
    await refused(h, /podman network argus-build-net does not exist/);
  });

  it("a missing or unprotected Build token, without ever printing the token", async () => {
    const missing = makeHarness();
    rmSync(missing.tokenPath);
    await refused(missing, /Build token file .* does not exist/);

    const open = makeHarness();
    chmodSync(open.tokenPath, 0o644);
    await refused(open, /readable by others/);
    expect(open.logs.join("\n")).not.toContain(TEST_TOKEN);
  });
});
