import { isAbsolute, posix } from "node:path";
import { TMPFS_DIRS, containerEnv } from "./sandbox.ts";

/**
 * The pure halves of the two containment checks (`pnpm verify:boot` reads the dry run, `pnpm verify:contain` runs the real
 * containers). Nothing here touches podman: the scripts feed in the dry-run text or the probe's report and print the verdicts.
 */

/** Splits a logged command line the way `sandbox.ts` printed it: spaces separate, double quotes (JSON style) group. */
export function tokenize(line: string): string[] {
  const out: string[] = [];
  const re = /"((?:[^"\\]|\\.)*)"|(\S+)/g;
  for (let m = re.exec(line); m; m = re.exec(line)) out.push(m[1] !== undefined ? (JSON.parse(`"${m[1]}"`) as string) : m[2]!);
  return out;
}

const values = (t: readonly string[], flag: string) => t.flatMap((a, i) => (a === flag ? [t[i + 1] ?? ""] : []));
const has = (t: readonly string[], ...seq: string[]) => t.some((_, i) => seq.every((s, j) => t[i + j] === s));

/** Flags every container of a Build carries, whatever its role. */
const COMMON_REQUIRED = ["--rm", "--pull=never", "--userns=keep-id", "--cap-drop=all"] as const;
const FORBIDDEN_FLAGS = ["--privileged", "--env-host", "--device", "--pid=host", "--ipc=host", "--userns=host", "--uts=host", "--net=host", "--network=host"];
const FORBIDDEN_ENV = /^(ANTHROPIC_API_KEY|GH_TOKEN|GITHUB_TOKEN|CLOUDFLARE_\w*|CF_\w*|NPM_TOKEN|SSH_AUTH_SOCK|AWS_\w*)$/;
const ROLE_NAME = /^argus-(build|install|bundle|egress)-\d+-/;

/** A mount source that is, or contains, the Operator's home would hand the agent the credentials the container exists to hide. */
function exposesHome(source: string, home: string): boolean {
  const h = resolveAbs(home);
  const s = resolveAbs(source);
  return s === "/" || s === h || h.startsWith(`${s}/`);
}

/** An absolute path with `.`, `..` and repeated slashes folded away, the way the kernel will read it. A relative path is returned as is (callers refuse those first). */
function resolveAbs(p: string): string {
  return isAbsolute(p) ? posix.normalize(p).replace(/(.)\/+$/, "$1") : p;
}

export interface PolicyOptions {
  operatorHome: string;
  /** When given, every mount source must be one of these directories or inside one. */
  mountRoots?: readonly string[];
  /** When given, the image must be exactly this tag. */
  image?: string;
  /** Check the program after the image too (the dry run's); false for argv whose command a probe replaced. Default true. */
  checkCommand?: boolean;
}

const ROLE_COMMANDS: Record<string, string> = { build: "claude", install: "pnpm install --frozen-lockfile", bundle: "wrangler deploy", egress: "node /opt/argus/egress-proxy.mjs" };
const BOOL_FLAGS = new Set(["--rm", "--init", "--read-only"]);
const intIn = (v: string, lo: number, hi: number) => /^[0-9]{1,9}$/.test(v) && Number(v) >= lo && Number(v) <= hi;
const GIB = 2 ** 30;
function memoryOk(v: string): boolean {
  const m = /^([0-9]+(?:\.[0-9]+)?)([mg])$/.exec(v);
  if (!m) return false;
  const bytes = Number(m[1]) * (m[2] === "g" ? GIB : 2 ** 20);
  return bytes > 0 && bytes <= 64 * GIB;
}
const EQ_FLAGS: Record<string, (v: string) => boolean> = {
  "--pull": (v) => v === "never",
  "--userns": (v) => v === "keep-id",
  "--cap-drop": (v) => v === "all",
  "--log-driver": (v) => v === "none",
  "--pids-limit": (v) => intIn(v, 1, 65536),
  "--memory": memoryOk,
  "--cpus": (v) => /^[0-9]+(?:\.[0-9]+)?$/.test(v) && Number(v) > 0 && Number(v) <= 64,
  "--timeout": (v) => intIn(v, 1, 172800),
};
const VALUE_FLAGS = new Set(["--name", "--label", "--security-opt", "--tmpfs", "--network", "-v", "-w", "--env", "-e"]);
/** Flags that take a value we refuse outright; named so the message says what was tried. */
const REFUSED_WITH_VALUE = new Set(["--user", "-u", "--env-file", "--add-host", "--cgroupns", "--cap-add", "--device", "--volume", "--mount", "--secret", "--volumes-from", "--pid", "--ipc", "--uts", "--hostname", "--dns", "--entrypoint"]);
const LABEL_KEYS: Record<string, RegExp> = { "argus.build": /^[0-9]+$/, "argus.role": /^(agent|install|bundle|egress)$/, "argus.owner": /^[0-9]+\.[0-9]+$/, "argus.data": /^[0-9a-f]{12}$/ };
const pathUnder = (p: string, root: string) => {
  if (!isAbsolute(p) || !isAbsolute(root)) return false;
  const [a, r] = [resolveAbs(p), resolveAbs(root)];
  return a === r || a.startsWith(`${r === "/" ? "" : r}/`);
};

/**
 * The strict half of the policy: every flag of the `podman run` must be on the list for its role, with a valid value; the mounts,
 * environment, image and command must be the expected ones. An unknown flag is a failure until someone adds it here on purpose.
 */
function checkAllowlist(t: readonly string[], role: string, o: PolicyOptions): string[] {
  const problems: string[] = [];
  const bad = (m: string) => problems.push(`${role}: ${m}`);
  const start = t.indexOf("run") + 1;
  const mounts: Array<{ src: string; dest: string }> = [];
  const tmpfsSeen = new Set<string>();
  let cwd: string | undefined;
  let i = start;
  for (; i < t.length; i++) {
    const a = t[i]!;
    if (!a.startsWith("-")) break;
    const eq = a.startsWith("--") ? a.indexOf("=") : -1;
    if (eq > 0) {
      const k = a.slice(0, eq);
      if (!EQ_FLAGS[k]) bad(REFUSED_WITH_VALUE.has(k) || k === "--privileged" ? `forbidden flag ${a}` : `unknown flag ${a}`);
      else if (!EQ_FLAGS[k]!(a.slice(eq + 1))) bad(`invalid value in ${a}`);
    } else if (BOOL_FLAGS.has(a) || (a === "-d" && role === "egress")) {
      // known, no value
    } else if (VALUE_FLAGS.has(a)) {
      const v = t[++i] ?? "";
      if (a === "--label") {
        const [k = "", ...rest] = v.split("=");
        if (!LABEL_KEYS[k]?.test(rest.join("="))) bad(`unexpected label ${JSON.stringify(v)}`);
      } else if (a === "--security-opt") {
        if (v !== "no-new-privileges") bad(`forbidden --security-opt ${v}`);
      } else if (a === "--tmpfs") {
        const dir = v.split(":")[0] ?? "";
        if (role === "egress" || !(TMPFS_DIRS as readonly string[]).includes(dir) || !new RegExp(`^${dir}:rw,noexec,nosuid,nodev,size=[0-9]+[gm]$`).test(v)) bad(`unexpected --tmpfs ${v}`);
        else if (tmpfsSeen.has(dir)) bad(`repeated --tmpfs ${dir}`);
        tmpfsSeen.add(dir);
      } else if (a === "--network") {
        const ok = role === "bundle" ? v === "none" : role === "egress" ? v === "podman" || /^argus-build-net:ip=[0-9.]+$/.test(v) : v === "argus-build-net";
        if (!ok) bad(`unexpected --network ${v}`);
      } else if (a === "-w") {
        cwd = v;
      } else if (a === "-v") {
        const [src = "", dest = "", opts, ...extra] = v.split(":");
        if (role === "egress") bad(`egress takes no mounts, got ${v}`);
        if (opts !== "Z" || extra.length > 0) bad(`mount options of ${v} must be exactly Z`);
        if (dest !== src && dest !== "/home/agent") bad(`mount destination ${dest} is neither the source path nor /home/agent`);
        mounts.push({ src, dest });
        if (o.mountRoots && !o.mountRoots.some((r) => pathUnder(src, r))) bad(`mount source ${src} is outside the expected directories ${o.mountRoots.join(", ")}`);
      } else if (a === "--env" || a === "-e") {
        const n = v.split("=")[0]!;
        const allowed = role === "egress" ? ["ARGUS_EGRESS_ALLOW"] : containerEnv(role === "build" ? "agent" : (role as "install" | "bundle"), "/x").map(([k]) => k);
        if (FORBIDDEN_ENV.test(n) || /(TOKEN|KEY|SECRET|PASSWORD|CREDENTIAL)/i.test(n)) {
          if (!(n === "CLAUDE_CODE_OAUTH_TOKEN" && role === "build")) bad(`forbidden env ${n}`);
        } else if (!allowed.includes(n)) bad(`unexpected env ${n}`);
        else if (n === "CLAUDE_CODE_OAUTH_TOKEN" && v.includes("=")) bad("the token has a value on the command line");
      }
    } else if (REFUSED_WITH_VALUE.has(a)) {
      bad(`forbidden flag ${a}`);
      i++;
    } else {
      bad(a === "--privileged" || a === "--env-host" ? `forbidden flag ${a}` : `unknown flag ${a}`);
    }
  }
  const image = t[i];
  if (image === undefined) bad("no image in the podman run");
  else if (o.image ? image !== o.image : !/^localhost\/argus-build:[A-Za-z0-9._-]+$/.test(image) || image.endsWith(":latest")) bad(`unexpected image ${image}`);
  if (cwd !== undefined && !mounts.some((m) => pathUnder(cwd!, m.dest))) bad(`working directory ${cwd} is not inside a mount`);
  if (o.checkCommand !== false && image !== undefined) {
    const cmd = t.slice(i + 1).join(" ");
    const want = ROLE_COMMANDS[role]!;
    if (role === "build" || role === "bundle" ? cmd !== want && !cmd.startsWith(`${want} `) : cmd !== want) bad(`unexpected command ${JSON.stringify(cmd.slice(0, 80))}`);
  }
  return problems;
}

/** Problems with one `podman run` line (tokens after `podman`). Empty when it meets the policy of its role. */
export function checkRunTokens(t: readonly string[], o: PolicyOptions): string[] {
  const problems: string[] = [];
  const name = values(t, "--name")[0] ?? "";
  const role = ROLE_NAME.exec(name)?.[1];
  if (!role) return [`podman run with no argus container name (${JSON.stringify(name)})`];
  const need = (ok: boolean, what: string) => {
    if (!ok) problems.push(`${role}: missing ${what}`);
  };
  for (const f of COMMON_REQUIRED) need(t.includes(f), f);
  need(has(t, "--security-opt", "no-new-privileges"), "--security-opt no-new-privileges");
  need(t.includes("--read-only"), "--read-only");
  need(values(t, "--label").some((l) => l.startsWith("argus.build=")), "label argus.build");
  need(values(t, "--label").some((l) => l.startsWith("argus.owner=")), "label argus.owner");
  const networks = values(t, "--network");
  if (role === "egress") {
    need(networks.some((n) => n.startsWith("argus-build-net:ip=")), "--network argus-build-net:ip=...");
    need(networks.includes("podman"), "--network podman");
    need(values(t, "--env").some((e) => e.startsWith("ARGUS_EGRESS_ALLOW=")), "ARGUS_EGRESS_ALLOW");
  } else {
    need(t.includes("--init"), "--init");
    need(t.includes("--log-driver=none"), "--log-driver=none");
    for (const p of ["--pids-limit=", "--memory=", "--cpus=", "--timeout="]) need(t.some((a) => a.startsWith(p)), `${p}N`);
    for (const dir of TMPFS_DIRS) {
      const opts = values(t, "--tmpfs").find((v) => v.startsWith(`${dir}:`))?.split(":")[1]?.split(",") ?? [];
      for (const opt of ["noexec", "nosuid", "nodev"]) need(opts.includes(opt), `--tmpfs ${dir} with ${opt}`);
    }
    const want = role === "bundle" ? "none" : "argus-build-net";
    need(networks.length === 1 && networks[0] === want, `--network ${want} (and no other)`);
    need(values(t, "-v").some((v) => v.includes(":/home/agent:")), "the per-Build home at /home/agent");
  }
  // Forbidden things, whatever the role.
  for (const f of FORBIDDEN_FLAGS) if (t.includes(f)) problems.push(`${role}: forbidden flag ${f}`);
  if (networks.includes("host")) problems.push(`${role}: forbidden --network host`);
  if (has(t, "--security-opt", "seccomp=unconfined") || has(t, "--security-opt", "label=disable")) problems.push(`${role}: forbidden --security-opt`);
  for (const flag of ["--cap-add", "--volumes-from", "--mount", "--secret", "--volume"]) if (t.some((a) => a === flag || a.startsWith(`${flag}=`))) problems.push(`${role}: forbidden ${flag}`);
  for (const v of values(t, "-v")) {
    const [source = "", dest = ""] = v.split(":");
    if (!isAbsolute(source)) problems.push(`${role}: mount source ${JSON.stringify(source)} is not an absolute host path`);
    else if (exposesHome(source, o.operatorHome)) problems.push(`${role}: mount source ${source} exposes the Operator's home ${o.operatorHome}`);
    if (/docker\.sock|podman\.sock|^\/(proc|sys|dev|etc|run|root|boot|usr|bin|sbin|lib\w*)(\/|$)|^\/var\/(run|lib|log)(\/|$)/.test(resolveAbs(source))) problems.push(`${role}: mount source ${source} is a system path`);
    if (dest.startsWith("/proc") || dest.startsWith("/sys")) problems.push(`${role}: mount destination ${dest}`);
  }
  for (const e of values(t, "--env")) {
    const n = e.split("=")[0]!;
    if (FORBIDDEN_ENV.test(n)) problems.push(`${role}: forbidden env ${n}`);
    // The Build token goes by name only: a value on the command line is visible in `ps` and `podman inspect` of the client.
    if (n === "CLAUDE_CODE_OAUTH_TOKEN" && e.includes("=")) problems.push(`${role}: the token has a value on the command line`);
    if (n === "CLAUDE_CODE_OAUTH_TOKEN" && role !== "build") problems.push(`${role}: the token is only for the agent`);
  }
  problems.push(...checkAllowlist(t, role, o));
  return problems;
}

/** How many `podman run` lines of each role a Build dry run shows: the agent and the install each get a sidecar, the bundle has no network. */
export const DRY_RUN_ROLES: Record<string, number> = { egress: 2, build: 1, install: 1, bundle: 1 };

/** Reads the `podman run` lines out of a worker's dry-run output and checks each. Every role must appear the expected number of times. */
export function checkDryRunOutput(stdout: string, o: PolicyOptions): string[] {
  const problems: string[] = [];
  const seen: string[] = [];
  const podmanLines: string[][] = [];
  for (const line of stdout.split("\n")) {
    const at = line.indexOf("dry-run: ");
    if (at < 0) continue;
    const t = tokenize(line.slice(at + "dry-run: ".length));
    if (!/(^|\/)podman$/.test(t[0] ?? "")) continue;
    podmanLines.push(t);
    if (t[1] !== "run") continue;
    const role = ROLE_NAME.exec(values(t, "--name")[0] ?? "")?.[1];
    if (role) seen.push(role);
    problems.push(...checkRunTokens(t, o));
  }
  for (const [r, want] of Object.entries(DRY_RUN_ROLES)) {
    const n = seen.filter((s) => s === r).length;
    if (n !== want) problems.push(`the dry run shows ${n} podman run line(s) for ${r}, expected ${want}`);
  }
  // Teardown is part of the contract: every container started is stopped and removed by name.
  for (const word of ["stop", "rm"]) if (!podmanLines.some((t) => t[1] === word)) problems.push(`the dry run shows no podman ${word}`);
  return problems;
}

/** What the probe script prints from inside a Build container (scripts/verify-contain.mjs holds the script). */
export interface ProbeReport {
  uid: number;
  capEff: string;
  capBnd: string;
  capPrm: string;
  capInh: string;
  noNewPrivs: string;
  home: string;
  envNames: string[];
  /** Host-side paths that must be absent: path -> true when it exists inside the container. */
  paths: Record<string, boolean>;
  /** path -> true when a write there succeeded */
  writes: Record<string, boolean>;
  /** dir -> whether a copy of a real binary could be placed there, and whether running it worked (it must not) */
  execFrom: Record<string, { copied: boolean; ran: boolean }>;
  /** mount point -> mount options */
  mounts: Record<string, string>;
  cgroup: { memoryMax?: string; pidsMax?: string; cpuMax?: string };
  /** target -> true when a direct TCP connect (ignoring the proxy) or name lookup succeeded */
  direct: Record<string, boolean>;
  /** CONNECT/GET target -> first status line the proxy answered, or "closed" */
  proxy: Record<string, string>;
  /** program -> true when it is on PATH */
  tools: Record<string, boolean>;
}

export interface Check {
  name: string;
  /** The finding this check shows fixed: HIGH2 (agent not contained) or MED4 (process half, template dir). */
  finding: "HIGH2" | "MED4";
  ok: boolean;
  detail: string;
}

export interface ProbeExpect {
  uid: number;
  repo: string;
  home: string;
  /** The caps the container was started with. */
  caps: { memoryGiB: number; cpus: number; pids: number };
  /** Env names the container may hold (besides the engine's own). */
  allowedEnv: string[];
  /** Further mount points the job legitimately has (none for the agent). */
  extraMounts?: string[];
  /** Targets that the proxy must tunnel; every other proxy target must be refused. */
  proxyAllowed: string[];
}

const ENGINE_ENV = new Set(["PATH", "HOSTNAME", "container", "PWD", "SHLVL", "_", "OLDPWD", "TERM", "NODE_VERSION", "YARN_VERSION"]);
/** Mount points every container of the engine has, besides /proc, /sys and /dev and what is under them. */
const CONTAINER_MOUNTS = new Set(["/", "/tmp", "/etc/hosts", "/etc/hostname", "/etc/resolv.conf", "/run", "/run/.containerenv", "/run/podman-init", "/run/secrets", "/var/tmp"]);
const SYSTEM_TOOLS = ["gh", "ssh", "curl", "wget", "wrangler"];

/** Turns the probe's report into one verdict per HIGH2 / MED4 bullet it can show. */
export function judgeProbe(r: ProbeReport, e: ProbeExpect): Check[] {
  const out: Check[] = [];
  const add = (finding: Check["finding"], name: string, bad: string[], good: string) => out.push({ name, finding, ok: bad.length === 0, detail: bad.length ? bad.join("; ") : good });
  const mounted = (m: string) => m in r.mounts;

  add("HIGH2", "host credentials and the template are not reachable", [
    ...Object.entries(r.paths).filter(([, v]) => v).map(([p]) => `${p} exists in the container`),
    ...(r.home === "/home/agent" ? [] : [`HOME is ${r.home}`]),
  ], `${Object.keys(r.paths).length} host paths absent, HOME=/home/agent`);
  add("MED4", "the template directory is not mounted at all (it is never writable)", Object.entries(r.paths).filter(([p, v]) => v && /argus-build-template/.test(p)).map(([p]) => `${p} exists`), "template path absent");
  add("HIGH2", "only the repo and the per-Build home are host mounts", [
    ...Object.keys(r.mounts).filter((m) => !(CONTAINER_MOUNTS.has(m) || /^\/(proc|sys|dev)(\/|$)/.test(m) || m === e.repo || m === e.home || m === "/home/agent" || e.extraMounts?.includes(m))).map((m) => `unexpected mount ${m}`),
    ...(mounted(e.repo) ? [] : [`repo ${e.repo} is not mounted`]),
    ...(mounted("/home/agent") ? [] : ["/home/agent is not mounted"]),
  ], "repo and /home/agent only");
  add("HIGH2", "no secrets in the environment", [
    ...r.envNames.filter((n) => !ENGINE_ENV.has(n) && !e.allowedEnv.includes(n)).map((n) => `unexpected env ${n}`),
    ...r.envNames.filter((n) => FORBIDDEN_ENV.test(n)).map((n) => `forbidden env ${n}`),
  ], `${r.envNames.length} variables, all on the allowlist`);
  add("HIGH2", "unprivileged: mapped uid, no capabilities, no new privileges", [
    ...(r.uid === e.uid ? [] : [`uid ${r.uid}, expected ${e.uid}`]),
    // keep-id leaves CapEff at 0 whether or not --cap-drop=all is set; the bounding set is what the flag empties.
    ...(["capEff", "capBnd", "capPrm", "capInh"] as const).flatMap((k) => (/^0+$/.test(r[k] ?? "") ? [] : [`${k.replace("cap", "Cap")} ${r[k]}`])),
    ...(r.noNewPrivs === "1" ? [] : [`NoNewPrivs ${r.noNewPrivs}`]),
  ], `uid ${r.uid}, CapEff/CapPrm/CapInh/CapBnd all 0, NoNewPrivs 1`);
  add("HIGH2", "writes outside the repo and home fail (read-only root)", [
    ...Object.entries(r.writes).filter(([k, v]) => v && k !== e.repo && k !== e.home && !TMPFS_DIRS.some((d) => k === d || k.startsWith(`${d}/`))).map(([k]) => `write to ${k} succeeded`),
    ...(r.writes[e.repo] ? [] : ["the repo is not writable"]),
    ...(r.writes[e.home] ? [] : ["the home is not writable"]),
    ...(r.mounts["/"]?.split(",").includes("ro") ? [] : ["root is not read-only"]),
  ], "only the repo, home and the tmpfs dirs take writes");
  add("HIGH2", "nothing runs from /tmp, /var/tmp or /run (noexec, nosuid, nodev)", TMPFS_DIRS.flatMap((d) => {
    const opts = r.mounts[d]?.split(",");
    const probe = r.execFrom?.[d];
    return [
      ...(opts ? ["noexec", "nosuid", "nodev"].filter((o) => !opts.includes(o)).map((o) => `${d} is not mounted ${o}`) : [`${d} is not a mount of its own`]),
      // Nothing could be copied in: that proves nothing about exec unless the independent write probe shows the directory is not writable
      // for this uid at all (the engine's /run tmpfs is root-owned 0755), in which case there is nothing to run from it.
      ...(!probe ? [`${d} was not probed for exec`] : !probe.copied ? (r.writes[d] === false ? [] : [`${d}: no binary could be placed there, so the exec test proves nothing`]) : probe.ran ? [`a binary copied to ${d} ran`] : []),
    ];
  }), "the exec probe was refused where a binary could be placed, the rest is not writable, and each is mounted noexec,nosuid,nodev");
  add("HIGH2", "no direct network egress (IP and name, ignoring the proxy)", Object.entries(r.direct).filter(([, v]) => v).map(([k]) => `direct connection to ${k} succeeded`), `${Object.keys(r.direct).length} targets unreachable`);
  const status = (k: string) => r.proxy[k] ?? "missing";
  const tunnelled = (k: string) => /^HTTP\/1\.[01] 200/.test(status(k));
  add("HIGH2", "the proxy tunnels only the allowlisted hosts", [
    ...e.proxyAllowed.filter((k) => !tunnelled(k)).map((k) => `${k} -> ${status(k)}`),
    ...Object.keys(r.proxy).filter((k) => !e.proxyAllowed.includes(k) && tunnelled(k)).map((k) => `${k} was allowed`),
  ], `${e.proxyAllowed.join(" and ")} tunnelled; ${Object.keys(r.proxy).length - e.proxyAllowed.length} other requests refused`);
  add("HIGH2", "resource caps are applied (memory, pids, cpu)", [
    ...(r.cgroup.memoryMax === String(e.caps.memoryGiB * 2 ** 30) ? [] : [`memory.max ${r.cgroup.memoryMax}`]),
    ...(r.cgroup.pidsMax === String(e.caps.pids) ? [] : [`pids.max ${r.cgroup.pidsMax}`]),
    ...(r.cgroup.cpuMax?.startsWith(`${e.caps.cpus * 100000} `) ? [] : [`cpu.max ${r.cgroup.cpuMax}`]),
  ], `memory ${r.cgroup.memoryMax}, pids ${r.cgroup.pidsMax}, cpu ${r.cgroup.cpuMax}`);
  add("HIGH2", "the image has no gh, ssh, curl, wget or wrangler", SYSTEM_TOOLS.filter((k) => r.tools[k]).map((k) => `${k} is in the image`), "none present");
  return out;
}
