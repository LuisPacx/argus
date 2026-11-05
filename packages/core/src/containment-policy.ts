import { isAbsolute } from "node:path";

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
  const h = home.replace(/\/+$/, "");
  const s = source.replace(/\/+$/, "") || "/";
  return s === "/" || s === h || h.startsWith(`${s}/`);
}

/** Problems with one `podman run` line (tokens after `podman`). Empty when it meets the policy of its role. */
export function checkRunTokens(t: readonly string[], o: { operatorHome: string }): string[] {
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
    need(values(t, "--tmpfs").some((v) => v.startsWith("/tmp:") && v.split(":")[1]!.split(",").includes("noexec")), "--tmpfs /tmp with noexec");
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
    if (/docker\.sock|podman\.sock|^\/(proc|sys|dev|etc|run|root|boot|usr|bin|sbin|lib\w*)(\/|$)|^\/var\/(run|lib|log)(\/|$)/.test(source)) problems.push(`${role}: mount source ${source} is a system path`);
    if (dest.startsWith("/proc") || dest.startsWith("/sys")) problems.push(`${role}: mount destination ${dest}`);
  }
  for (const e of values(t, "--env")) {
    const n = e.split("=")[0]!;
    if (FORBIDDEN_ENV.test(n)) problems.push(`${role}: forbidden env ${n}`);
    // The Build token goes by name only: a value on the command line is visible in `ps` and `podman inspect` of the client.
    if (n === "CLAUDE_CODE_OAUTH_TOKEN" && e.includes("=")) problems.push(`${role}: the token has a value on the command line`);
    if (n === "CLAUDE_CODE_OAUTH_TOKEN" && role !== "build") problems.push(`${role}: the token is only for the agent`);
  }
  return problems;
}

/** How many `podman run` lines of each role a Build dry run shows: the agent and the install each get a sidecar, the bundle has no network. */
export const DRY_RUN_ROLES: Record<string, number> = { egress: 2, build: 1, install: 1, bundle: 1 };

/** Reads the `podman run` lines out of a worker's dry-run output and checks each. Every role must appear the expected number of times. */
export function checkDryRunOutput(stdout: string, o: { operatorHome: string }): string[] {
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
  noNewPrivs: string;
  home: string;
  envNames: string[];
  /** Host-side paths that must be absent: path -> true when it exists inside the container. */
  paths: Record<string, boolean>;
  /** path -> true when a write there succeeded */
  writes: Record<string, boolean>;
  /** true when a file copied to /tmp could be executed */
  tmpExec: boolean;
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
  /** Targets that the proxy must tunnel; every other proxy target must be refused. */
  proxyAllowed: string[];
}

const ENGINE_ENV = new Set(["PATH", "HOSTNAME", "container", "PWD", "SHLVL", "_", "OLDPWD", "TERM", "NODE_VERSION", "YARN_VERSION"]);
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
    ...Object.keys(r.mounts).filter((m) => /^\/(home|root|mnt|media|run\/user|var\/home)(\/|$)/.test(m) && m !== e.repo && m !== e.home && m !== "/home/agent").map((m) => `unexpected mount ${m}`),
    ...(mounted(e.repo) ? [] : [`repo ${e.repo} is not mounted`]),
    ...(mounted("/home/agent") ? [] : ["/home/agent is not mounted"]),
  ], "repo and /home/agent only");
  add("HIGH2", "no secrets in the environment", [
    ...r.envNames.filter((n) => !ENGINE_ENV.has(n) && !e.allowedEnv.includes(n)).map((n) => `unexpected env ${n}`),
    ...r.envNames.filter((n) => FORBIDDEN_ENV.test(n)).map((n) => `forbidden env ${n}`),
  ], `${r.envNames.length} variables, all on the allowlist`);
  add("HIGH2", "unprivileged: mapped uid, no capabilities, no new privileges", [
    ...(r.uid === e.uid ? [] : [`uid ${r.uid}, expected ${e.uid}`]),
    ...(/^0+$/.test(r.capEff) ? [] : [`CapEff ${r.capEff}`]),
    ...(r.noNewPrivs === "1" ? [] : [`NoNewPrivs ${r.noNewPrivs}`]),
  ], `uid ${r.uid}, CapEff 0, NoNewPrivs 1`);
  add("HIGH2", "writes outside the repo and home fail (read-only root)", [
    ...Object.entries(r.writes).filter(([k, v]) => v && k !== e.repo && k !== e.home && k !== "/tmp" && !k.startsWith("/tmp/")).map(([k]) => `write to ${k} succeeded`),
    ...(r.writes[e.repo] ? [] : ["the repo is not writable"]),
    ...(r.writes[e.home] ? [] : ["the home is not writable"]),
    ...(r.mounts["/"]?.split(",").includes("ro") ? [] : ["root is not read-only"]),
  ], "only the repo, home and /tmp take writes");
  add("HIGH2", "nothing runs from /tmp (noexec)", [...(r.tmpExec ? ["a binary copied to /tmp ran"] : []), ...(r.mounts["/tmp"]?.split(",").includes("noexec") ? [] : ["/tmp is not mounted noexec"])], "exec from /tmp refused");
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
