import { describe, expect, it } from "vitest";
import { checkDryRunOutput, checkRunTokens, judgeProbe, tokenize, type ProbeExpect, type ProbeReport } from "./containment-policy.ts";
import { DEFAULT_CAPS, PodmanSandbox, containerEnv, type SandboxJob } from "./sandbox.ts";
import { TEST_IMAGE } from "./testing/build-harness.ts";

const HOME = "/home/operator";
const sandbox = new PodmanSandbox({ image: TEST_IMAGE, tokenPath: "/nonexistent", dataDir: "/work/data", owner: "4242.99" });
const jobs: SandboxJob[] = [
  { role: "agent", buildId: 3, cwd: "/work/repo", mounts: ["/work/repo"], home: "/work/data/proposals/3/home", args: ["-p", "do it"], timeoutMs: 600_000 },
  { role: "install", buildId: 3, cwd: "/work/seal/work/export", mounts: ["/work/seal/work"], home: "/work/seal/home", args: [], timeoutMs: 600_000 },
  { role: "bundle", buildId: 3, cwd: "/work/seal/work", mounts: ["/work/seal/work"], home: "/work/seal/home", args: [], binDir: "/work/seal/work/export/node_modules/.bin", timeoutMs: 600_000 },
];
/** What the worker prints for a Build's dry run, through the same `describe` the worker calls. */
const dryRun = () => jobs.flatMap((j) => sandbox.describe(j)).map((l) => `[build 3] dry-run: ${l}`).join("\n");
const lines = (text: string) => text.split("\n");
const runLine = (text: string, name: string) => lines(text).findIndex((l) => l.includes("podman run") && l.includes(`--name ${name}`));
/** The dry-run text with one edit applied to the `podman run` line of the container whose name starts with `prefix`. */
const edit = (prefix: string, f: (line: string) => string) => {
  const text = dryRun();
  const all = lines(text);
  const i = all.findIndex((l) => l.includes("podman run") && l.includes(`--name ${prefix}`));
  expect(i).toBeGreaterThanOrEqual(0);
  all[i] = f(all[i]!);
  return all.join("\n");
};

describe("tokenize", () => {
  it("splits on spaces and keeps double-quoted arguments whole", () => {
    expect(tokenize('podman run --label "a b" x')).toEqual(["podman", "run", "--label", "a b", "x"]);
    expect(tokenize('a "q\\"uote"')).toEqual(["a", 'q"uote']);
  });
});

describe("checkDryRunOutput", () => {
  it("accepts the real dry run of the three Build jobs", () => {
    expect(checkDryRunOutput(dryRun(), { operatorHome: HOME })).toEqual([]);
  });

  it.each([
    ["--cap-drop=all", "agent", "build"],
    ["--read-only", "agent", "build"],
    ["--pull=never", "install", "install"],
    ["--userns=keep-id", "bundle", "bundle"],
    ["--init", "agent", "build"],
    ["--log-driver=none", "agent", "build"],
  ])("fails when %s is dropped from the %s container", (flag, _role, prefix) => {
    const problems = checkDryRunOutput(edit(`argus-${prefix}`, (l) => l.replace(` ${flag}`, "")), { operatorHome: HOME });
    expect(problems.join("\n")).toContain(flag);
  });

  it("fails when no-new-privileges, the noexec tmpfs, the network or the caps go", () => {
    expect(checkDryRunOutput(edit("argus-build", (l) => l.replace(" --security-opt no-new-privileges", "")), { operatorHome: HOME }).join()).toContain("no-new-privileges");
    expect(checkDryRunOutput(edit("argus-build", (l) => l.replace(",noexec", "")), { operatorHome: HOME }).join()).toContain("noexec");
    expect(checkDryRunOutput(edit("argus-bundle", (l) => l.replace("--network none", "--network argus-build-net")), { operatorHome: HOME }).join()).toContain("--network none");
    expect(checkDryRunOutput(edit("argus-build", (l) => l.replace("--network argus-build-net", "--network podman")), { operatorHome: HOME }).join()).toContain("--network argus-build-net");
    expect(checkDryRunOutput(edit("argus-build", (l) => l.replace(/ --memory=\S+/, "")), { operatorHome: HOME }).join()).toContain("--memory=");
  });

  it.each(["--privileged", "--device /dev/fuse", "--env-host", "--cap-add SYS_ADMIN", "--pid=host", "--network host", "--security-opt seccomp=unconfined"])("fails when the agent container adds %s", (extra) => {
    const problems = checkDryRunOutput(edit("argus-build", (l) => l.replace("podman run", `podman run ${extra}`)), { operatorHome: HOME });
    expect(problems.length).toBeGreaterThan(0);
  });

  it("fails when a mount exposes the Operator's home, its parent or the root", () => {
    for (const source of [HOME, "/home", "/"]) {
      const problems = checkDryRunOutput(edit("argus-build", (l) => l.replace("-v /work/repo:", `-v ${source}:`)), { operatorHome: HOME });
      expect(problems.join()).toContain("exposes the Operator's home");
    }
  });

  it("fails on a system mount, a secret env name and a token with a value", () => {
    expect(checkDryRunOutput(edit("argus-build", (l) => l.replace("podman run", "podman run -v /run/user/1000/podman/podman.sock:/s:Z")), { operatorHome: HOME }).join()).toContain("system path");
    expect(checkDryRunOutput(edit("argus-build", (l) => l.replace("podman run", "podman run --env GH_TOKEN")), { operatorHome: HOME }).join()).toContain("GH_TOKEN");
    expect(checkDryRunOutput(edit("argus-build", (l) => l.replace("--env CLAUDE_CODE_OAUTH_TOKEN", "--env CLAUDE_CODE_OAUTH_TOKEN=abc")), { operatorHome: HOME }).join()).toContain("token has a value");
    expect(checkDryRunOutput(edit("argus-install", (l) => l.replace("podman run", "podman run --env CLAUDE_CODE_OAUTH_TOKEN")), { operatorHome: HOME }).join()).toContain("only for the agent");
  });

  it("fails when a role's podman run line, or the stop and rm lines, are missing", () => {
    const all = lines(dryRun());
    const dropped = all.filter((l) => !(l.includes("podman run") && l.includes("--name argus-install"))).join("\n");
    expect(checkDryRunOutput(dropped, { operatorHome: HOME }).join()).toContain("0 podman run line(s) for install");
    expect(checkDryRunOutput(all.filter((l) => !/podman (stop|rm) /.test(l)).join("\n"), { operatorHome: HOME }).join()).toContain("no podman stop");
    expect(checkDryRunOutput("", { operatorHome: HOME }).length).toBeGreaterThan(0);
  });

  it("checks the sidecar too", () => {
    const problems = checkDryRunOutput(edit("argus-egress", (l) => l.replace(" --network podman", "")), { operatorHome: HOME });
    expect(problems.join()).toContain("egress: missing --network podman");
    expect(runLine(dryRun(), "argus-egress-3-<nonce>")).toBeGreaterThanOrEqual(0);
  });
});

describe("checkDryRunOutput: allowlist per role", () => {
  const add = (prefix: string, extra: string) => edit(prefix, (l) => l.replace("podman run", `podman run ${extra}`));
  const problemsOf = (text: string, o: Partial<Parameters<typeof checkDryRunOutput>[1]> = {}) => checkDryRunOutput(text, { operatorHome: HOME, ...o });

  it("accepts the real dry run with the mount roots and the image pinned", () => {
    expect(problemsOf(dryRun(), { mountRoots: ["/work"], image: TEST_IMAGE })).toEqual([]);
  });

  it.each([
    ["-e GH_TOKEN=x", /unexpected env GH_TOKEN|forbidden env GH_TOKEN/],
    ["-e FOO=1", /unexpected env FOO/],
    ["--env FOO=1", /unexpected env FOO/],
    ["--env-file /home/operator/.env", /--env-file/],
    ["--user 0", /--user/],
    ["-u root", /-u/],
    ["--cgroupns=host", /--cgroupns/],
    ["--add-host evil:1.2.3.4", /--add-host/],
    ["--privileged", /--privileged/],
    ["--security-opt label=disable", /--security-opt/],
    ["--security-opt seccomp=unconfined", /--security-opt/],
    ["--security-opt apparmor=unconfined", /--security-opt/],
    ["--pids-limit=0", /--pids-limit/],
    ["--pids-limit=-1", /--pids-limit/],
    ["--memory=0", /--memory/],
    ["--memory=9999g", /--memory/],
    ["--cpus=0", /--cpus/],
    ["--cpus=9999", /--cpus/],
    ["--timeout=0", /--timeout/],
    ["--some-new-flag", /unknown flag --some-new-flag/],
    ["--hostname=x", /forbidden flag/],
    ["-v /srv/other:/srv/other:Z", /mount source/],
    ["-v /work/repo:/etc:Z", /mount destination/],
    ["-v /work/repo:/work/repo:rw", /mount options/],
    ["--label foo=bar", /label/],
  ])("fails when the agent container adds %s", (extra, pattern) => {
    const problems = problemsOf(add("argus-build", extra), { mountRoots: ["/work"] });
    expect(problems.join("\n")).toMatch(pattern);
  });

  it("fails on mounts outside the expected roots, even when they are not the home", () => {
    expect(problemsOf(edit("argus-build", (l) => l.replace("-v /work/repo:", "-v /home/operator/.ssh:")), { mountRoots: ["/work"] }).join()).toMatch(/mount source/);
    expect(problemsOf(edit("argus-build", (l) => l.replace("-v /work/repo:", "-v /home/operator/.config/gh:")), { mountRoots: ["/work"] }).join()).toMatch(/mount source/);
  });

  it("fails on an unpinned or other image and on a changed command", () => {
    expect(problemsOf(edit("argus-build", (l) => l.replace(TEST_IMAGE, "docker.io/library/node:latest")), { image: TEST_IMAGE }).join()).toMatch(/image/);
    expect(problemsOf(edit("argus-install", (l) => l.replace("pnpm install --frozen-lockfile", "sh -c evil"))).join()).toMatch(/command/);
  });

  it("fails on a bad flag in the sidecar", () => {
    expect(problemsOf(add("argus-egress", "--privileged")).join()).toMatch(/--privileged/);
    expect(problemsOf(add("argus-egress", "-v /work:/work:Z")).join()).toMatch(/egress.*mount|mount.*egress/);
  });
});

describe("checkRunTokens", () => {
  it("refuses a podman run that is not an argus container", () => {
    expect(checkRunTokens(tokenize("run --name other"), { operatorHome: HOME })).toHaveLength(1);
  });
});

const EXPECT: ProbeExpect = { uid: 1000, repo: "/work/repo", home: "/work/home", caps: { memoryGiB: DEFAULT_CAPS.memoryGiB, cpus: DEFAULT_CAPS.cpus, pids: DEFAULT_CAPS.pids }, allowedEnv: containerEnv("agent").map(([k]) => k), proxyAllowed: ["api.anthropic.com:443", "registry.npmjs.org:443"] };
const GOOD: ProbeReport = {
  uid: 1000,
  capEff: "0000000000000000",
  capBnd: "0000000000000000",
  capPrm: "0000000000000000",
  capInh: "0000000000000000",
  noNewPrivs: "1",
  home: "/home/agent",
  envNames: ["HOME", "PATH", "HTTPS_PROXY", "CLAUDE_CODE_OAUTH_TOKEN", "HOSTNAME", "container"],
  paths: { "/home/operator/.config": false, "/home/operator/code/argus-build-template": false },
  writes: { "/work/repo": true, "/work/home": true, "/": false, "/usr": false, "/etc": false, "/tmp/x": true, "/work": false },
  tmpExec: false,
  mounts: { "/": "ro,relatime", "/tmp": "rw,nosuid,nodev,noexec", "/work/repo": "rw", "/home/agent": "rw", "/proc": "rw", "/dev/shm": "rw", "/etc/hosts": "ro", "/run/.containerenv": "ro", "/run/podman-init": "ro", "/var/tmp": "rw" },
  cgroup: { memoryMax: String(8 * 2 ** 30), pidsMax: "1024", cpuMax: "400000 100000" },
  direct: { "1.1.1.1:443": false, "example.com (dns)": false },
  proxy: { "api.anthropic.com:443": "HTTP/1.1 200 Connection Established", "registry.npmjs.org:443": "HTTP/1.1 200 OK", "example.com:443": "HTTP/1.1 403 Forbidden", "GET http://api.anthropic.com/": "closed" },
  tools: { gh: false, ssh: false, curl: false, wget: false, wrangler: false, node: true },
};
const failing = (r: ProbeReport) => judgeProbe(r, EXPECT).filter((c) => !c.ok).map((c) => c.name);

describe("judgeProbe", () => {
  it("passes a contained container and tags every check with HIGH2 or MED4", () => {
    const checks = judgeProbe(GOOD, EXPECT);
    expect(failing(GOOD)).toEqual([]);
    expect(checks.every((c) => c.finding === "HIGH2" || c.finding === "MED4")).toBe(true);
    expect(checks.some((c) => c.finding === "MED4")).toBe(true);
  });

  it.each<[string, Partial<ProbeReport>, RegExp]>([
    ["a host credential path exists", { paths: { "/home/operator/.ssh": true } }, /credentials/],
    ["the template exists", { paths: { "/home/operator/code/argus-build-template": true } }, /template/],
    ["HOME is not the per-Build home", { home: "/home/operator" }, /credentials/],
    ["an extra home mount", { mounts: { ...GOOD.mounts, "/home/operator/code": "rw" } }, /host mounts/],
    ["an extra mount outside the old prefix list", { mounts: { ...GOOD.mounts, "/srv/data": "rw" } }, /host mounts/],
    ["an extra mount under /data", { mounts: { ...GOOD.mounts, "/data": "rw" } }, /host mounts/],
    ["a secret in the env", { envNames: [...GOOD.envNames, "GH_TOKEN"] }, /secrets/],
    ["root", { uid: 0 }, /unprivileged/],
    ["a capability", { capEff: "0000000000000400" }, /unprivileged/],
    ["a bounding-set capability (cap-drop missing, keep-id zeroes only CapEff)", { capBnd: "00000000a80425fb" }, /unprivileged/],
    ["a permitted capability", { capPrm: "0000000000000001" }, /unprivileged/],
    ["an inheritable capability", { capInh: "0000000000000001" }, /unprivileged/],
    ["a write outside", { writes: { ...GOOD.writes, "/usr": true } }, /writes outside/],
    ["root is writable", { mounts: { ...GOOD.mounts, "/": "rw" } }, /writes outside/],
    ["exec from /tmp", { tmpExec: true }, /noexec/],
    ["a direct connection", { direct: { "1.1.1.1:443": true } }, /no direct network/],
    ["the proxy allows another host", { proxy: { ...GOOD.proxy, "github.com:443": "HTTP/1.1 200 OK" } }, /proxy tunnels/],
    ["the proxy refuses the npm registry", { proxy: { ...GOOD.proxy, "registry.npmjs.org:443": "HTTP/1.1 403 Forbidden" } }, /proxy tunnels/],
    ["the memory cap is missing", { cgroup: { ...GOOD.cgroup, memoryMax: "max" } }, /caps/],
    ["wrangler in the image", { tools: { ...GOOD.tools, wrangler: true } }, /no gh/],
  ])("fails when %s", (_what, over, pattern) => {
    const names = failing({ ...GOOD, ...over });
    expect(names.some((n) => pattern.test(n))).toBe(true);
  });
});
