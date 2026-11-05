import { spawn, type ChildProcess } from "node:child_process";
import net from "node:net";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const ENTRY = fileURLToPath(new URL("./egress-proxy.mjs", import.meta.url));
const children: ChildProcess[] = [];
afterEach(() => {
  for (const c of children.splice(0)) c.kill("SIGKILL");
});

/** Start the real entry file in a child process with only the env given (no inherited secrets). */
function start(env: Record<string, string>) {
  const child = spawn(process.execPath, [ENTRY], { env: { PATH: process.env.PATH ?? "", ...env }, stdio: ["ignore", "pipe", "pipe"] });
  children.push(child);
  let out = "";
  let err = "";
  child.stdout!.on("data", (d) => (out += d));
  child.stderr!.on("data", (d) => (err += d));
  const exited = new Promise<{ code: number | null }>((ok) => child.on("exit", (code) => ok({ code })));
  const listening = async () => {
    const deadline = Date.now() + 5000;
    for (;;) {
      const line = out.split("\n").find((l) => l.includes(`"event":"listening"`));
      if (line) return JSON.parse(line) as { port: number; allow: string[] };
      if (Date.now() > deadline) throw new Error(`no listening line; stdout=${out} stderr=${err}`);
      await new Promise((ok) => setTimeout(ok, 25));
    }
  };
  return { child, exited, listening, stdout: () => out, stderr: () => err };
}

function send(port: number, bytes: string): Promise<string> {
  return new Promise((ok, fail) => {
    const s = net.connect(port, "127.0.0.1");
    let got = "";
    s.on("data", (d) => (got += d));
    s.on("close", () => ok(got));
    s.on("error", fail);
    s.write(bytes);
  });
}

describe("egress-proxy.mjs entry", () => {
  it("prints a listening line, refuses non-allowlisted CONNECT and plain HTTP, logs denials to stdout, and exits 0 on SIGTERM", async () => {
    const p = start({ ARGUS_EGRESS_ALLOW: "api.anthropic.com:443,registry.npmjs.org:443", ARGUS_EGRESS_PORT: "0", ARGUS_EGRESS_HOST: "127.0.0.1" });
    const { port, allow } = await p.listening();
    expect(allow).toEqual(["api.anthropic.com:443", "registry.npmjs.org:443"]);
    expect(await send(port, "CONNECT example.com:443 HTTP/1.1\r\n\r\n")).toMatch(/^HTTP\/1\.1 403 /);
    expect(await send(port, "CONNECT 169.254.169.254:443 HTTP/1.1\r\n\r\n")).toMatch(/^HTTP\/1\.1 403 /);
    expect(await send(port, "GET http://api.anthropic.com/ HTTP/1.1\r\n\r\n")).toMatch(/^HTTP\/1\.1 405 /);
    const lines = p.stdout().trim().split("\n").map((l) => JSON.parse(l));
    expect(lines.filter((l) => l.event === "denied").map((l) => l.reason)).toEqual(["host-not-allowed", "ip-literal", "method-not-allowed"]);
    p.child.kill("SIGTERM");
    expect((await p.exited).code).toBe(0);
  });

  it.each([
    ["no allowlist", {}],
    ["an empty allowlist", { ARGUS_EGRESS_ALLOW: " , " }],
    ["a wildcard entry", { ARGUS_EGRESS_ALLOW: "*.anthropic.com:443" }],
    ["a non-443 entry", { ARGUS_EGRESS_ALLOW: "api.anthropic.com:80" }],
    ["an IP-literal entry", { ARGUS_EGRESS_ALLOW: "1.1.1.1:443" }],
    ["a bad port", { ARGUS_EGRESS_ALLOW: "api.anthropic.com:443", ARGUS_EGRESS_PORT: "99999" }],
  ])("refuses to start with %s", async (_name, env) => {
    const p = start(env);
    expect((await p.exited).code).toBe(1);
    expect(p.stderr()).toContain("egress-proxy:");
    expect(p.stdout()).not.toContain(`"event":"listening"`);
  });
});
