// Spawns the real page-check script and a real headless browser against a throwaway local server. Slow tier.
// Self-skips when the matching Chromium headless shell is not installed.
import { execFile } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { tempDir } from "../packages/core/src/testing/temp.ts";
// @ts-expect-error plain .mjs script, no types
import { chooseBrowser, expectedRevision } from "./page-check.mjs";

const installed = chooseBrowser(path.join(os.homedir(), ".cache", "ms-playwright"), expectedRevision()) !== null;

const BAD = `<!doctype html><title>bad</title><script>console.error("kaboom-from-page")</script><img src="/missing.png" alt="">`;
const GOOD = `<!doctype html><title>good</title><button id="a" data-test="open">Open</button>
<div id="panel" hidden role="dialog"><button id="close">Close</button></div>
<script>
const a = document.getElementById("a"), p = document.getElementById("panel"), c = document.getElementById("close");
a.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); p.hidden = false; c.focus(); } });
p.addEventListener("keydown", (e) => { if (e.key === "Escape") { p.hidden = true; a.focus(); } });
</script>`;

const FORM = `<!doctype html><title>form</title><form method="post" action="/submit"><button id="go" type="submit">Go</button></form>`;
const posts: string[] = [];
const profiles = () => fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith("playwright"));

let server: http.Server;
let port = 0;
beforeAll(async () => {
  server = http.createServer((req, res) => {
    if (req.method === "POST") posts.push(req.url ?? "");
    if (req.url === "/form") res.writeHead(200, { "content-type": "text/html" }).end(FORM);
    else if (req.method === "POST") res.writeHead(200).end("posted");
    else
    if (req.url === "/bad") res.writeHead(200, { "content-type": "text/html" }).end(BAD);
    else if (req.url === "/good") res.writeHead(200, { "content-type": "text/html" }).end(GOOD);
    else res.writeHead(404).end("no");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as { port: number }).port;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

/** Ask the OS for a free port (listen on 0), then release it for the child to take. */
async function freePort(): Promise<number> {
  const s = http.createServer();
  await new Promise<void>((resolve) => s.listen(0, "127.0.0.1", resolve));
  const p = (s.address() as { port: number }).port;
  await new Promise<void>((resolve) => s.close(() => resolve()));
  return p;
}

function run(args: string[], env?: NodeJS.ProcessEnv): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve) => {
    execFile("node", [path.resolve(import.meta.dirname, "page-check.mjs"), ...args], { timeout: 50000, env: env ? { ...process.env, ...env } : process.env }, (err, stdout, stderr) => {
      resolve({ code: err ? ((err as { code?: number }).code ?? 1) : 0, stdout: stdout + stderr });
    });
  });
}

describe.skipIf(!installed)("page-check in a real headless browser", { timeout: 60000 }, () => {
  it("fails a page with a console error and a 404 image, and names both", async () => {
    const out = tempDir("page-check-out-");
    const r = await run(["/bad", "--port", String(port), "--out", out]);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("kaboom-from-page");
    expect(r.stdout).toContain("/missing.png");
    expect(fs.existsSync(path.join(out, "bad-1240.png"))).toBe(true);
    expect(fs.existsSync(path.join(out, "bad-390.png"))).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(out, "bad.json"), "utf8")).exit).toBe(1);
  });

  it("passes a healthy page and records focus and visibility after each key step", async () => {
    const out = tempDir("page-check-out-");
    const r = await run(["/good", "--port", String(port), "--out", out, "--keys", "focus=#a,Enter,Escape", "--watch", "#panel"]);
    expect(r.code).toBe(0);
    const json = JSON.parse(fs.readFileSync(path.join(out, "good.json"), "utf8"));
    const log = json.keys["1240"];
    expect(log.map((s: { focus: { id: string } }) => s.focus.id)).toEqual(["a", "close", "a"]);
    expect(log.map((s: { visible: Record<string, boolean> }) => s.visible["#panel"])).toEqual([false, true, false]);
    expect(fs.existsSync(path.join(out, "good-390-keys.png"))).toBe(true);
  });

  it("blocks a state-changing request that Enter would send, fails, and leaves no temp profile", async () => {
    const before = profiles();
    const out = tempDir("page-check-out-");
    const r = await run(["/form", "--port", String(port), "--out", out, "--keys", "focus=#go,Enter"]);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("blocked POST");
    expect(posts).toEqual([]);
    expect(profiles()).toEqual(before);
  });

  it("--expect-post lets the Enter POST through the check without sending it, and fails when it never happens", async () => {
    const out = tempDir("page-check-out-");
    const ok = await run(["/form", "--port", String(port), "--out", out, "--keys", "focus=#go,Enter", "--expect-post", "/submit"]);
    expect(ok.stdout).toContain("expected POST seen: POST /submit");
    expect(ok.code).toBe(0);
    expect(posts).toEqual([]); // stubbed, never sent
    const json = JSON.parse(fs.readFileSync(path.join(out, "form.json"), "utf8"));
    expect(json.expectedPosts.wanted).toEqual(["/submit"]);
    expect(json.expectedPosts.seen[0]).toMatchObject({ method: "POST", path: "/submit" });

    const other = await run(["/form", "--port", String(port), "--out", tempDir("page-check-out-"), "--keys", "focus=#go,Enter", "--expect-post", "/other"]);
    expect(other.code).toBe(1);
    expect(other.stdout).toContain("blocked POST"); // a POST to any other path still fails
    expect(other.stdout).toContain("expected POST never seen: /other");

    const never = await run(["/good", "--port", String(port), "--out", tempDir("page-check-out-"), "--keys", "focus=#a", "--expect-post", "/submit"]);
    expect(never.code).toBe(1);
    expect(never.stdout).toContain("expected POST never seen: /submit");
    expect(posts).toEqual([]);
  });

  it("--seed starts a private War Room on sample data, checks a page, and leaves no dir, process group or port behind", { timeout: 240000 }, async () => {
    const out = tempDir("page-check-out-");
    const r = await new Promise<{ code: number; stdout: string }>((resolve) => {
      // no --port: the tool takes a free port from the OS itself
      execFile("node", [path.resolve(import.meta.dirname, "page-check.mjs"), "--seed", "/proposals/{hostile}", "--out", out], { timeout: 220000 }, (err, stdout, stderr) => {
        resolve({ code: err ? ((err as { code?: number }).code ?? 1) : 0, stdout: stdout + stderr });
      });
    });
    const seedPort = Number(/seed cleanup: port (\d+) free, dir removed/.exec(r.stdout)![1]);
    expect(seedPort).toBeGreaterThan(1023);
    expect([3100, 3217, 3351, 3361, 3371]).not.toContain(seedPort);
    expect(r.stdout).toContain(`output folder: ${out}`);
    expect(r.code).toBe(0);
    const line = r.stdout.split("\n").find((l) => l.startsWith("seed: "))!;
    const dir = /dir (\S+)/.exec(line)![1]!;
    const pgid = Number(/pgid (\d+)/.exec(line)![1]);
    const json = JSON.parse(fs.readFileSync(path.join(out, "proposals-2.json"), "utf8"));
    expect(json).toMatchObject({ seeded: true, exit: 0 });
    expect(json.widths.every((w: { overflow: boolean }) => !w.overflow)).toBe(true);
    expect(path.basename(dir)).toMatch(/^page-seed-[A-Za-z0-9]{6}$/); // fs.mkdtemp, never a pid-named dir a later run could find stale
    expect(fs.existsSync(dir)).toBe(false);
    expect(() => process.kill(-pgid, 0)).toThrow(/ESRCH/);
  });

  it("two simultaneous runs without --out write to two different folders, and each prints its folder, also when it fails", async () => {
    const tmp = tempDir("page-check-tmp-"); // TMPDIR for the children, so nothing lands in the real temp area
    const [a, b] = await Promise.all([run(["/good", "--port", String(port)], { TMPDIR: tmp }), run(["/bad", "--port", String(port)], { TMPDIR: tmp })]);
    expect(a.code).toBe(0);
    expect(b.code).toBe(1); // the failing run still names its folder
    const folder = (s: string) => /^output folder: (.+)$/m.exec(s)?.[1];
    const fa = folder(a.stdout)!;
    const fb = folder(b.stdout)!;
    expect(fa).toBeTruthy();
    expect(fb).toBeTruthy();
    expect(fa).not.toBe(fb);
    expect(path.dirname(fa)).toBe(path.join(tmp, "page-check"));
    expect(path.dirname(fb)).toBe(path.join(tmp, "page-check"));
    expect(fs.existsSync(path.join(fa, "good-1240.png"))).toBe(true);
    expect(fs.existsSync(path.join(fb, "bad-1240.png"))).toBe(true);
    expect(fs.existsSync(path.join(fa, "bad-1240.png"))).toBe(false);
    expect(fs.existsSync(path.join(fb, "good-1240.png"))).toBe(false);
  });

  it("uses the given --port as given: nothing there is a failed run that still prints its folder", async () => {
    const tmp = tempDir("page-check-tmp-");
    const dead = await freePort(); // nothing listens
    const r = await run(["/good", "--port", String(dead)], { TMPDIR: tmp });
    expect(r.code).toBe(1);
    expect(r.stdout).toContain(`localhost:${dead}`);
    expect(r.stdout).toMatch(/^output folder: /m);
  });

  it("exits 2 for a non-local path", async () => {
    const r = await run(["//evil.example/", "--port", String(port), "--out", tempDir("page-check-out-")]);
    expect(r.code).toBe(2);
  });
});
