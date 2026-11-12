import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { statSync, readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { BUILD_NETWORK, imageReady } from "./build-image.ts";
import type { BuildRefusalCode, PreflightRefusal } from "./build-refusal.ts";

/**
 * The Build container (containment design, ADR 0005 to come): every command that runs agent-written or agent-influenced code
 * (the claude run, the dependency install and the dry-run bundle) is a rootless podman container of the pinned image. This module
 * is the one place that knows podman: the argv builder is pure and tested against an allowlist, the `SandboxRunner` seam is what
 * the brain and the Build Runner call, and the fake `podman` of the tests stands in for the real one behind it.
 */

/** Where the per-Build home is mounted inside the container. */
export const AGENT_HOME = "/home/agent";
/** Every container argus starts carries this label (value: the Proposal id), so startup can find leftovers and nothing else. */
export const BUILD_LABEL = "argus.build";
/** The only hosts the egress sidecar lets a Build container reach. */
export const EGRESS_ALLOW: readonly string[] = ["api.anthropic.com:443", "registry.npmjs.org:443"];
/** The sidecar's fixed address on the internal network (design 5.2): one at a time, which is how Builds run. */
export const EGRESS_ADDRESS = "10.89.77.2";
export const EGRESS_PORT = 3128;
const PROXY_URL = `http://${EGRESS_ADDRESS}:${EGRESS_PORT}`;
/** The image's own PATH (the Containerfile sets it); a bundle puts the project's bin directory in front of it. */
const IMAGE_PATH = "/usr/local/bin:/usr/local/sbin:/usr/sbin:/usr/bin:/sbin:/bin";
const EGRESS_NETWORK_UPSTREAM = "podman";

export type ContainerRole = "agent" | "install" | "bundle";
/** The program each role runs; a job's args are appended. */
const ROLE_COMMAND: Record<ContainerRole, readonly string[]> = {
  agent: ["claude"],
  install: ["pnpm", "install", "--frozen-lockfile"],
  // `wrangler` is found on PATH, which holds the export's node_modules/.bin (the job's `binDir`): what `pnpm exec` would arrange,
  // without pnpm insisting on a package.json in the working directory.
  bundle: ["wrangler", "deploy"],
};
const ROLE_NAME: Record<ContainerRole, string> = { agent: "build", install: "install", bundle: "bundle" };
/** Roles whose container reaches the allowlisted hosts (through the sidecar); the bundle has no network at all. */
const ROLE_HAS_NETWORK: Record<ContainerRole, boolean> = { agent: true, install: true, bundle: false };

export interface SandboxCaps {
  memoryGiB: number;
  cpus: number;
  pids: number;
  tmpGiB: number;
}
/** The Operator's decision (design section 13, Q6). */
export const DEFAULT_CAPS: SandboxCaps = { memoryGiB: 8, cpus: 4, pids: 1024, tmpGiB: 2 };

/**
 * A tmpfs is memory: what is written to /tmp counts against the container's `--memory` cap like its processes do. So the tmpfs of
 * all three dirs together may take at most this share of the cap, and the agent always keeps the rest for its processes (at the
 * defaults: 2 GiB /tmp + 256 MiB /var/tmp + 64 MiB /run = 2.31 GiB of the 8 GiB, leaving 5.7 GiB). A configuration beyond it is an error.
 */
export const TMPFS_MEMORY_SHARE = 0.5;
const GIB = 2 ** 30;
const MIB = 2 ** 20;

/** Directories that are writable tmpfs in every Build container, and so must never allow execution. */
export const TMPFS_DIRS = ["/tmp", "/var/tmp", "/run"] as const;
/** Size of each tmpfs, in MiB: /tmp is the one the Operator sizes (`tmpGiB`); the other two are small and fixed. */
function tmpfsSizesMiB(caps: Pick<SandboxCaps, "tmpGiB">): Record<(typeof TMPFS_DIRS)[number], number> {
  return { "/tmp": Math.round(caps.tmpGiB * 1024), "/var/tmp": 256, "/run": 64 };
}
const tmpfsTotalBytes = (caps: Pick<SandboxCaps, "tmpGiB">): number => Object.values(tmpfsSizesMiB(caps)).reduce((a, b) => a + b, 0) * MIB;

/** Can the tmpfs dirs of a container with these caps fill without taking more than `TMPFS_MEMORY_SHARE` of its memory cap? */
export function tmpfsFitsMemory(caps: Pick<SandboxCaps, "memoryGiB" | "tmpGiB">): boolean {
  return tmpfsTotalBytes(caps) <= caps.memoryGiB * GIB * TMPFS_MEMORY_SHARE;
}

function assertTmpfsFits(caps: SandboxCaps): void {
  if (!tmpfsFitsMemory(caps)) {
    throw new Error(
      `the tmpfs of a Build container (/tmp ${caps.tmpGiB} GiB, /var/tmp 256 MiB, /run 64 MiB: ${(tmpfsTotalBytes(caps) / GIB).toFixed(2)} GiB) could take more than ${TMPFS_MEMORY_SHARE * 100}% of its memory cap of ${caps.memoryGiB} GiB; lower ARGUS_BUILD_TMP_GIB or raise ARGUS_BUILD_MEMORY_GIB`,
    );
  }
}

/** Caps from `ARGUS_BUILD_MEMORY_GIB`, `ARGUS_BUILD_CPUS`, `ARGUS_BUILD_PIDS`, `ARGUS_BUILD_TMP_GIB`; a value that is not a positive number is an error, never a silent default. */
export function capsFromEnv(env: NodeJS.ProcessEnv): SandboxCaps {
  const read = (name: string, fallback: number): number => {
    const raw = env[name];
    if (raw === undefined || raw === "") return fallback;
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) throw new Error(`${name} must be a positive number, got ${JSON.stringify(raw.slice(0, 40))}`);
    return n;
  };
  const caps = {
    memoryGiB: read("ARGUS_BUILD_MEMORY_GIB", DEFAULT_CAPS.memoryGiB),
    cpus: read("ARGUS_BUILD_CPUS", DEFAULT_CAPS.cpus),
    pids: Math.floor(read("ARGUS_BUILD_PIDS", DEFAULT_CAPS.pids)),
    tmpGiB: read("ARGUS_BUILD_TMP_GIB", DEFAULT_CAPS.tmpGiB),
  };
  assertTmpfsFits(caps);
  return caps;
}

/** One container run, as the callers describe it. */
export interface SandboxJob {
  role: ContainerRole;
  /** The Proposal's id: names and labels carry it. */
  buildId: number;
  /** Working directory inside the container; the same absolute path as on the host. */
  cwd: string;
  /** Host directories mounted read-write at the same path inside (the repo; or the bundle's work directory). */
  mounts: readonly string[];
  /** Host directory mounted at /home/agent: the claude config dir, the package store and caches. */
  home: string;
  /** Appended after the role's program (`claude`, `pnpm install --frozen-lockfile`, `wrangler deploy`). */
  args: readonly string[];
  /** The bundle role only: the host directory (mounted at the same path) whose executables, the project's wrangler, go first on PATH. */
  binDir?: string;
  /** The wall-clock cap the caller enforces; the container gets a minute more as a crash-proof backstop (`--timeout`). */
  timeoutMs: number;
  signal?: AbortSignal;
  /** Where the sandbox reports things worth putting in the Build log (the sidecar's denials). */
  note?: (line: string) => void;
}

/** What to spawn for a job, and how to end it. */
export interface SandboxRun {
  command: string;
  args: string[];
  /** The environment of the process that is spawned (the podman client), never that of the container. */
  env: Record<string, string>;
  /** `podman stop`, then `rm -f`, of the container and its sidecar. Idempotent; resolves once both are gone. */
  stop(): Promise<void>;
}

/** The seam: the brain and the Build Runner start agent-influenced code only through this. */
export interface SandboxRunner {
  /** Why a Build cannot start (podman, image, network or token missing), or undefined when it can. */
  preflight(): Promise<string | undefined>;
  /** The same check with its refusal code (`podman-missing`, `image-missing`, `network-missing`, `token-*`). */
  preflightRefusal(): Promise<PreflightRefusal | undefined>;
  /** Stops and removes every container an earlier worker left behind (by label only). Returns their names. */
  reconcile(log?: (line: string) => void): Promise<string[]>;
  /** Starts what the job needs besides its own container (the egress sidecar) and returns the command that runs it. */
  launch(job: SandboxJob): Promise<SandboxRun>;
  /** The commands `launch` would run, for the dry run. Runs nothing. */
  describe(job: SandboxJob): string[];
  /** The token and caps are not secrets, the image is: the tag the Builds run. */
  readonly image: string;
  /** Who this worker is: minted once at boot, labels its containers and names its seals. */
  readonly owner: string;
}

const NAME_RE = /^argus-(?:build|install|bundle|egress)-\d+-[0-9a-f]{8}$/;

function checkMountPath(p: string): string {
  // A colon or comma would let the path add mount options; anything not already normalised is not what was meant.
  if (!isAbsolute(p) || resolve(p) !== p || /[:,\0\n\r]/.test(p) || p === "/") throw new Error(`refusing to mount ${JSON.stringify(p)}`);
  return p;
}

/** The env the container gets, by role: (name, value) pairs; a pair with no value is passed through from the podman client's environment. */
export function containerEnv(role: ContainerRole, binDir?: string): Array<[string, string | undefined]> {
  const proxy: Array<[string, string]> = [["HTTPS_PROXY", PROXY_URL], ["https_proxy", PROXY_URL], ["NO_PROXY", ""]];
  switch (role) {
    case "agent":
      return [
        ["HOME", AGENT_HOME],
        ["CLAUDE_CONFIG_DIR", `${AGENT_HOME}/.claude`],
        ["CLAUDE_CODE_DISABLE_CLAUDE_MDS", "1"],
        ["CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", "1"],
        ["DISABLE_AUTOUPDATER", "1"],
        ...proxy,
        // The Operator's ~/.gitconfig is not in the container, so the agent's commits need an identity of their own.
        ["GIT_AUTHOR_NAME", "argus"],
        ["GIT_AUTHOR_EMAIL", "argus@localhost"],
        ["GIT_COMMITTER_NAME", "argus"],
        ["GIT_COMMITTER_EMAIL", "argus@localhost"],
        ["GIT_CONFIG_GLOBAL", "/dev/null"],
        ["GIT_CONFIG_SYSTEM", "/dev/null"],
        ["CI", "1"],
        // No value: podman takes it from its own environment, so it is never on a command line.
        ["CLAUDE_CODE_OAUTH_TOKEN", undefined],
      ];
    case "install":
      return [["HOME", AGENT_HOME], ...proxy, ["CI", "1"]];
    case "bundle":
      if (!binDir) throw new Error("the bundle needs the directory of the project's wrangler");
      return [["HOME", AGENT_HOME], ["PATH", `${binDir}:${IMAGE_PATH}`], ["CI", "1"], ["WRANGLER_SEND_METRICS", "false"]];
  }
}

/** What /proc/<pid>/stat said: the process's state and start time, "gone" (ENOENT/ESRCH: no such process), or "unknown" (any other failure). */
export type ProcStatRead = { state: string; ticks: number } | "gone" | "unknown";
export type ReadProcStat = (pid: number) => ProcStatRead;

/** Field 3 (state) and field 22 (start time in ticks since boot) of a /proc/<pid>/stat read. Only a vanished file means the process is gone. */
export function parseProcStat(read: () => string): ProcStatRead {
  let stat: string;
  try {
    stat = read();
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return code === "ENOENT" || code === "ESRCH" ? "gone" : "unknown";
  }
  const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" "); // after "pid (comm) ": state is fields[0], starttime fields[19]
  const ticks = Number(fields[19]);
  return fields[19] && Number.isFinite(ticks) && fields[0] ? { state: fields[0], ticks } : "unknown";
}

const readProcStat: ReadProcStat = (pid) => parseProcStat(() => readFileSync(`/proc/${pid}/stat`, "utf8"));

/** Names a worker process: its pid and start time, so a reused pid is not mistaken for it. Labels on its containers and its seal directories carry it. Throws when the start time cannot be read: a token without one could never be told apart from a reused pid. */
export function ownerToken(pid = process.pid, read: ReadProcStat = readProcStat): string {
  const now = read(pid);
  if (typeof now === "string" || now.ticks === 0) throw new Error(`cannot name this worker: the start time of process ${pid} could not be read from /proc`);
  return `${pid}.${now.ticks}`;
}

export type OwnerState = "alive" | "dead" | "unknown";

/**
 * Is the process an owner token names still running? A token is read as data (it comes from a label or a directory name): anything
 * that is not `<pid>.<ticks>`, or has no start time, or whose /proc entry could not be read, is "unknown" and proves nothing.
 * Only a vanished process, a zombie, or a different start time (a reused pid) is "dead".
 */
export function ownerState(token: string, read: ReadProcStat = readProcStat): OwnerState {
  const m = /^([1-9][0-9]{0,9})\.([0-9]{1,15})$/.exec(token);
  if (!m) return "unknown";
  const ticks = Number(m[2]);
  if (ticks === 0) return "unknown";
  const now = read(Number(m[1]));
  if (now === "unknown") return "unknown";
  if (now === "gone") return "dead";
  return now.state !== "Z" && now.ticks === ticks ? "alive" : "dead";
}

/** Provably running. Anything that reaps must use `ownerState` and leave "unknown" alone. */
export function ownerAlive(token: string, read: ReadProcStat = readProcStat): boolean {
  return ownerState(token, read) === "alive";
}

/** Identifies a data directory in labels: containers of another checkout or data dir carry another id and are never touched. */
export function dataIdFor(dataDir: string): string {
  return createHash("sha256").update(resolve(dataDir)).digest("hex").slice(0, 12);
}

/** Who a container belongs to, as labels: the data dir it serves and the worker process that started it. */
export interface Ownership {
  dataId: string;
  owner: string;
}
const ownershipLabels = (o: Ownership): string[] => ["--label", `argus.data=${o.dataId}`, "--label", `argus.owner=${o.owner}`];

/** The `--tmpfs` flags of a Build container. `--read-only` makes podman add its own tmpfs on /var/tmp and /run without `noexec`; naming them here replaces those. */
function tmpfsFlags(caps: SandboxCaps): string[] {
  const sizes = tmpfsSizesMiB(caps);
  const size = (mib: number) => (mib % 1024 === 0 ? `${mib / 1024}g` : `${mib}m`);
  return TMPFS_DIRS.flatMap((d) => ["--tmpfs", `${d}:rw,noexec,nosuid,nodev,size=${size(sizes[d])}`]);
}

export interface RunSpec {
  job: SandboxJob;
  name: string;
  image: string;
  caps: SandboxCaps;
  ownership: Ownership;
}

/**
 * The `podman run` argv (after `podman`) for one job. Pure. Policy, all of it checked by tests against an allowlist: rootless
 * with the caller's uid mapped, no capabilities, no new privileges, read-only root, `noexec` tmpfs, no image pull, no log driver
 * copy of the output, an init, a PID limit and memory and CPU caps, the conmon timeout, the internal network (none at all for the
 * bundle), exactly the mounts the job names plus the home, and only the env of `containerEnv(role)`.
 */
export function buildPodmanRunArgs({ job, name, image, caps, ownership }: RunSpec): string[] {
  const { role } = job;
  if (!NAME_RE.test(name)) throw new Error(`bad container name ${JSON.stringify(name)}`);
  if (!Number.isInteger(job.buildId) || job.buildId < 0) throw new Error("bad build id");
  assertTmpfsFits(caps);
  const mounts = job.mounts.map(checkMountPath);
  const flags = [
    "run", "--rm", "--name", name,
    "--label", `${BUILD_LABEL}=${job.buildId}`, "--label", `argus.role=${role}`, ...ownershipLabels(ownership),
    "--pull=never", "--init", "--log-driver=none",
    "--userns=keep-id", "--cap-drop=all", "--security-opt", "no-new-privileges",
    "--read-only", ...tmpfsFlags(caps),
    `--pids-limit=${caps.pids}`, `--memory=${caps.memoryGiB}g`, `--cpus=${caps.cpus}`,
    `--timeout=${Math.ceil(job.timeoutMs / 1000) + 60}`,
    "--network", ROLE_HAS_NETWORK[role] ? BUILD_NETWORK.name : "none",
  ];
  for (const m of mounts) flags.push("-v", `${m}:${m}:Z`);
  flags.push("-v", `${checkMountPath(job.home)}:${AGENT_HOME}:Z`, "-w", checkMountPath(job.cwd));
  for (const [k, v] of containerEnv(role, job.binDir === undefined ? undefined : checkMountPath(job.binDir))) flags.push("--env", v === undefined ? k : `${k}=${v}`);
  return [...flags, image, ...ROLE_COMMAND[role], ...job.args];
}

/** The egress sidecar's `podman run` argv: dual-homed (the internal network at its fixed address, and the default network for the way out). */
export function egressRunArgs({ name, buildId, image, ownership }: { name: string; buildId: number; image: string; ownership: Ownership }): string[] {
  if (!NAME_RE.test(name)) throw new Error(`bad container name ${JSON.stringify(name)}`);
  return [
    "run", "-d", "--rm", "--name", name,
    "--label", `${BUILD_LABEL}=${buildId}`, "--label", "argus.role=egress", ...ownershipLabels(ownership),
    "--pull=never", "--userns=keep-id", "--cap-drop=all", "--security-opt", "no-new-privileges", "--read-only",
    "--pids-limit=256", "--memory=256m", "--cpus=1",
    "--network", `${BUILD_NETWORK.name}:ip=${EGRESS_ADDRESS}`, "--network", EGRESS_NETWORK_UPSTREAM,
    "--env", `ARGUS_EGRESS_ALLOW=${EGRESS_ALLOW.join(",")}`,
    image, "node", "/opt/argus/egress-proxy.mjs",
  ];
}

/** `cd <repo> && CLAUDE_CONFIG_DIR=<home>/.claude claude --resume <id>`: what the Operator runs on the host to continue a failed Build's session (consumed by ticket 08's card). */
export function resumeCommand(o: { repo: string; home: string; sessionId: string }): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(o.sessionId)) throw new Error("not a session id");
  const q = (s: string) => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, "'\\''")}'`);
  return `cd ${q(o.repo)} && CLAUDE_CONFIG_DIR=${q(`${o.home}/.claude`)} claude --resume ${o.sessionId}`;
}

/** The Build token: one line in a file only the Operator can read. Throws a message that never contains the token. */
export function readBuildToken(path: string): string {
  let st;
  try {
    st = statSync(path);
  } catch {
    throw new BuildTokenError("token-missing", `the Build token file ${path} does not exist (mint one with \`claude setup-token\` and save it there, chmod 600)`);
  }
  if (!st.isFile()) throw new BuildTokenError("token-not-file", `the Build token path ${path} is not a file`);
  if ((st.mode & 0o077) !== 0) throw new BuildTokenError("token-mode", `the Build token file ${path} is readable by others; chmod 600 it`);
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    // EACCES and friends: say so with the path only (the system error text is not passed on).
    throw new BuildTokenError("token-unreadable", `the Build token file ${path} cannot be read by the worker; chmod 600 it`);
  }
  const token = raw.trim();
  if (!token) throw new BuildTokenError("token-empty", `the Build token file ${path} is empty`);
  if (/\s/.test(token)) throw new BuildTokenError("token-multiline", `the Build token file ${path} holds more than one line`);
  return token;
}

/** A Build token problem with its refusal code, so nobody parses the code out of the English message. The message never holds the token. */
export class BuildTokenError extends Error {
  readonly code: Extract<BuildRefusalCode, `token-${string}`>;
  constructor(code: Extract<BuildRefusalCode, `token-${string}`>, message: string) {
    super(message);
    this.code = code;
  }
}

export interface PodmanSandboxOptions {
  /** The image to run, e.g. `localhost/argus-build:cc2.1.318-...`. Never pulled or built here. */
  image: string;
  podmanBin?: string;
  tokenPath: string;
  /** The data dir this worker serves. Its id labels every container, and reconcile touches only containers with the same id. */
  dataDir: string;
  /** Who this worker is, for the labels; default `ownerToken()` of this process. Tests inject others to play a dead or a live neighbour. */
  owner?: string;
  /** Where PATH, HOME and XDG_RUNTIME_DIR for the podman client come from. Default `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Extra variable names the podman client may inherit (tests point the fake with these). */
  passEnv?: readonly string[];
  caps?: SandboxCaps;
  /** `podman stop -t`: seconds between SIGTERM and SIGKILL inside the container. Default 5. */
  stopTimeoutSec?: number;
  /** How long to wait for the egress sidecar's "listening" line. Default 20 s. */
  egressWaitMs?: number;
  /** The bound, past the stop's own grace, on each podman call that ends a container (`stop`, `rm -f`). Default 30 s. A hung podman is killed and the teardown goes on. */
  teardownTimeoutMs?: number;
}

interface Podman {
  code: number | null;
  stdout: string;
  stderr: string;
  /** The call did not return within its bound and was killed. */
  timedOut?: boolean;
}

/** After this long past a call's bound, a podman client that has still not exited (a hung one, or one whose grandchild holds its pipes) is given up on. */
const HARD_KILL_GRACE_MS = 2000;

const show = (args: readonly string[]) => args.map((a) => (/[\s"'$]/.test(a) ? JSON.stringify(a) : a)).join(" ");
/** Resolves after `ms`, or as soon as `signal` aborts. */
const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });

export class PodmanSandbox implements SandboxRunner {
  readonly image: string;
  readonly owner: string;
  private readonly podmanBin: string;
  private readonly opts: PodmanSandboxOptions;
  private readonly caps: SandboxCaps;
  private readonly ownership: Ownership;

  constructor(opts: PodmanSandboxOptions) {
    this.owner = opts.owner ?? ownerToken();
    this.ownership = { dataId: dataIdFor(opts.dataDir), owner: this.owner };
    if (opts.image.endsWith(":latest") || !/^[A-Za-z0-9./_-]+:[A-Za-z0-9._-]+$/.test(opts.image)) throw new Error(`the Build image must be a pinned tag, got ${JSON.stringify(opts.image)}`);
    this.image = opts.image;
    this.opts = opts;
    this.podmanBin = opts.podmanBin ?? "podman";
    this.caps = opts.caps ?? DEFAULT_CAPS;
    assertTmpfsFits(this.caps);
  }

  /** The podman client's own environment: what it needs to find its rootless store and runtime dir, and nothing else. */
  private clientEnv(extra: Record<string, string> = {}): Record<string, string> {
    const source = this.opts.env ?? process.env;
    const env: Record<string, string> = {};
    for (const n of ["PATH", "HOME", "XDG_RUNTIME_DIR", ...(this.opts.passEnv ?? [])]) if (source[n] !== undefined) env[n] = source[n]!;
    return { ...env, ...extra };
  }

  /**
   * One podman call, bounded: after `timeoutMs`, or when `signal` aborts, the client is sent SIGKILL (a hung client may ignore
   * SIGTERM), and a client that still has not exited a moment later is given up on. Never rejects and always returns.
   */
  private podman(args: string[], timeoutMs = 30_000, signal?: AbortSignal): Promise<Podman> {
    return new Promise((res) => {
      const watchdog = setTimeout(() => {
        child.kill("SIGKILL");
        res({ code: null, stdout: "", stderr: `podman ${args[0] ?? ""} did not return within ${timeoutMs} ms`, timedOut: true });
      }, timeoutMs + HARD_KILL_GRACE_MS);
      // Not execFile's own `signal` option: it ends the client with SIGTERM, which a hung client may ignore.
      const onAbort = () => void child.kill("SIGKILL");
      const child = execFile(this.podmanBin, args, { env: this.clientEnv(), timeout: timeoutMs, killSignal: "SIGKILL", maxBuffer: 4 << 20 }, (err, stdout, stderr) => {
        clearTimeout(watchdog);
        signal?.removeEventListener("abort", onAbort);
        const code = err ? (typeof (err as { code?: unknown }).code === "number" ? (err as { code: number }).code : null) : 0;
        const timedOut = err !== null && (err as { killed?: boolean }).killed === true && !signal?.aborted;
        res({ code, stdout: String(stdout), stderr: String(stderr || (err ? err.message : "")), timedOut });
      });
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) onAbort();
    });
  }

  async preflight(): Promise<string | undefined> {
    return (await this.preflightRefusal())?.message;
  }

  async preflightRefusal(): Promise<PreflightRefusal | undefined> {
    const v = await this.podman(["--version"], 15_000);
    if (v.code !== 0) return { code: "podman-missing", message: `podman is not available (${this.podmanBin}; set ARGUS_PODMAN_BIN): ${v.stderr.trim().slice(0, 150)}` };
    if (!(await imageReady(this.image, this.podmanBin, this.clientEnv()))) return { code: "image-missing", message: `the Build image ${this.image} is not present; run \`pnpm image:build\`` };
    const n = await this.podman(["network", "exists", BUILD_NETWORK.name], 15_000);
    if (n.code !== 0) return { code: "network-missing", message: `the podman network ${BUILD_NETWORK.name} does not exist; run \`pnpm image:build\`` };
    try {
      readBuildToken(this.opts.tokenPath);
    } catch (e) {
      // Only the typed token errors reach here (their messages carry the path, never the token); anything else is a code-less bug.
      if (e instanceof BuildTokenError) return { code: e.code, message: e.message };
      throw e;
    }
    return undefined;
  }

  async reconcile(log: (line: string) => void = () => {}, readStat?: ReadProcStat): Promise<string[]> {
    const ps = await this.podman(["ps", "-a", "--filter", `label=${BUILD_LABEL}`, "--format", "json"]);
    if (ps.code !== 0) {
      log(`[worker] could not list leftover Build containers: ${ps.stderr.trim().slice(0, 150)}`);
      return [];
    }
    let rows: Array<{ Names?: unknown; Labels?: Record<string, string> | null }>;
    try {
      rows = JSON.parse(ps.stdout || "[]");
    } catch {
      log("[worker] could not read the list of leftover Build containers");
      return [];
    }
    const removed: string[] = [];
    for (const row of rows) {
      // The filter is podman's; a container is touched only if it carries our label and one of our names, belongs to this data
      // dir, and its owning worker is provably gone. A container with no owner, a garbled one, or a live one (the daemon beside
      // a `--once` run, or the other way round) is left alone; so is every container of another data dir or checkout.
      const name = Array.isArray(row.Names) ? row.Names[0] : row.Names;
      if (typeof name !== "string" || !NAME_RE.test(name) || !row.Labels || !(BUILD_LABEL in row.Labels)) continue;
      const { "argus.data": data, "argus.owner": owner } = row.Labels;
      if (data !== this.ownership.dataId || typeof owner !== "string" || !/^[1-9][0-9]{0,9}\.[0-9]{1,15}$/.test(owner)) continue;
      const state = ownerState(owner, readStat);
      if (state === "unknown") log(`[worker] left alone Build container ${name}: could not tell whether its owner ${owner} is running`);
      if (state !== "dead") continue;
      await this.endContainer(name, log);
      removed.push(name);
      log(`[worker] removed leftover Build container ${name}`);
    }
    return removed;
  }

  /**
   * `podman stop`, then `rm -f`, of one container. Either failing is not an error (the container may be gone already: `--rm`). Each
   * is bounded (the stop by its own grace plus `teardownTimeoutMs`), so a hung podman cannot hold the teardown up: the call is
   * killed, `say` is told, and the teardown carries on (to the rm, then to whatever the caller does next, such as the group kill).
   */
  private async endContainer(name: string, say?: (line: string) => void): Promise<void> {
    const stopSec = this.opts.stopTimeoutSec ?? 5;
    const bound = this.opts.teardownTimeoutMs ?? 30_000;
    const steps: Array<[string[], number]> = [
      [["stop", "--ignore", "-t", String(stopSec), name], stopSec * 1000 + bound],
      [["rm", "-f", "--ignore", name], bound],
    ];
    for (const [args, ms] of steps) {
      const r = await this.podman(args, ms);
      if (r.timedOut) say?.(`argus-sandbox: teardown of ${name} timed out (podman ${args[0]} did not return in ${ms} ms); carrying on, and the process group is killed regardless`);
    }
  }

  private names(job: SandboxJob): { container: string; egress: string } {
    const nonce = randomBytes(4).toString("hex");
    return { container: `argus-${ROLE_NAME[job.role]}-${job.buildId}-${nonce}`, egress: `argus-egress-${job.buildId}-${nonce}` };
  }

  describe(job: SandboxJob): string[] {
    const nonce = "00000000";
    const container = `argus-${ROLE_NAME[job.role]}-${job.buildId}-${nonce}`;
    const egress = `argus-egress-${job.buildId}-${nonce}`;
    const line = (args: string[]) => `${this.podmanBin} ${show(args)}`.replaceAll(nonce, "<nonce>");
    const lines: string[] = [];
    if (ROLE_HAS_NETWORK[job.role]) lines.push(line(egressRunArgs({ name: egress, buildId: job.buildId, image: this.image, ownership: this.ownership })));
    lines.push(line(buildPodmanRunArgs({ job, name: container, image: this.image, caps: this.caps, ownership: this.ownership })));
    const stopSec = this.opts.stopTimeoutSec ?? 5;
    const ends = [container, ...(ROLE_HAS_NETWORK[job.role] ? [egress] : [])];
    for (const n of ends) lines.push(line(["stop", "--ignore", "-t", String(stopSec), n]), line(["rm", "-f", "--ignore", n]));
    return lines;
  }

  async launch(job: SandboxJob): Promise<SandboxRun> {
    const names = this.names(job);
    const started: string[] = []; // in start order; ended in reverse
    let ending: Promise<void> | undefined;
    let denialsNoted = false;
    // Calls made while an end is under way share it; a call after it has finished ends everything again. That matters: a stop that
    // came before `podman run` had created the container ended nothing, and the caller's last stop, once the podman client has
    // exited, must not be answered from memory.
    const stop = () =>
      (ending ??= (async () => {
        try {
          for (const name of [...started].reverse()) {
            if (name === names.egress && !denialsNoted) {
              denialsNoted = true;
              await this.noteDenials(name, job);
            }
            await this.endContainer(name, job.note);
          }
        } finally {
          ending = undefined;
        }
      })());
    try {
      let extra: Record<string, string> = {};
      if (job.role === "agent") extra = { CLAUDE_CODE_OAUTH_TOKEN: readBuildToken(this.opts.tokenPath) };
      if (ROLE_HAS_NETWORK[job.role]) {
        started.push(names.egress);
        await this.startEgress(names.egress, job);
      }
      // Registered before it exists: stop() tolerates a container that was never created, and a kill that lands between here and
      // the spawn still ends whatever starts.
      started.push(names.container);
      return {
        command: this.podmanBin,
        args: buildPodmanRunArgs({ job, name: names.container, image: this.image, caps: this.caps, ownership: this.ownership }),
        env: this.clientEnv(extra),
        stop,
      };
    } catch (e) {
      await stop();
      throw e;
    }
  }

  private async startEgress(name: string, job: SandboxJob): Promise<void> {
    // The signal goes to every podman call here, so an abort ends the call in progress (and the wait between polls) at once instead
    // of being seen when the call returns. The caller's `stop` then removes whatever the interrupted call had made.
    const interrupted = () => new Error("interrupted while starting the egress proxy sidecar");
    const r = await this.podman(egressRunArgs({ name, buildId: job.buildId, image: this.image, ownership: this.ownership }), 60_000, job.signal);
    if (job.signal?.aborted) throw interrupted();
    if (r.code !== 0) throw new Error(`the egress proxy sidecar could not be started: ${r.stderr.trim().slice(0, 200)}`);
    const deadline = Date.now() + (this.opts.egressWaitMs ?? 20_000);
    for (;;) {
      if (job.signal?.aborted) throw interrupted();
      const logs = await this.podman(["logs", name], 15_000, job.signal);
      if (job.signal?.aborted) throw interrupted();
      if (logs.code !== 0) throw new Error(`the egress proxy sidecar exited before it was listening: ${logs.stderr.trim().slice(0, 200)}`);
      if (/"event":"listening"/.test(logs.stdout)) return;
      if (Date.now() > deadline) throw new Error("the egress proxy sidecar did not report listening in time");
      await sleep(100, job.signal);
    }
  }

  /** The sidecar's refusals, as lines in the Build log: what a Build tried to reach and was not allowed to. */
  private async noteDenials(name: string, job: SandboxJob): Promise<void> {
    if (!job.note) return;
    const logs = await this.podman(["logs", name], Math.min(15_000, this.opts.teardownTimeoutMs ?? 30_000));
    if (logs.code !== 0) return;
    let shown = 0;
    for (const line of logs.stdout.split("\n")) {
      let ev: { event?: unknown; target?: unknown; reason?: unknown };
      try {
        ev = JSON.parse(line);
      } catch {
        continue;
      }
      if (ev.event !== "denied") continue;
      if (++shown > 20) break;
      const clean = (v: unknown) => String(v ?? "?").replace(/[^\x20-\x7e]/g, "?").slice(0, 120);
      job.note(`argus-egress: denied ${clean(ev.target)} (${clean(ev.reason)})`);
    }
  }
}
