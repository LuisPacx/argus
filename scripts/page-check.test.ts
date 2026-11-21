import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { tempDir } from "../packages/core/src/testing/temp.ts";
// @ts-expect-error plain .mjs script, no types
import { buildUrl, KEEP_RUNS, chooseBrowser, decide, fileNames, freePort, isLocalUrl, makeRunDir, outBase, outDirProblem, parseArgs, parseKeys, pruneRuns, slugFor } from "./page-check.mjs";

const healthy = {
  widths: [
    { width: 1240, status: 200, scrollWidth: 1240, overflow: false },
    { width: 390, status: 200, scrollWidth: 390, overflow: false },
  ],
  consoleErrors: [],
  pageErrors: [],
  failedRequests: [],
};

describe("page-check URL and paths", () => {
  it("builds only localhost URLs and refuses other hosts and // paths", () => {
    expect(buildUrl(3100, "/pipeline")).toBe("http://localhost:3100/pipeline");
    expect(buildUrl(3100)).toBe("http://localhost:3100/");
    for (const bad of ["/\t/evil.example/x", "/\r/evil.example/x", "/\n/evil.example/x", "/\u0000x", "//evil.example/x","http://evil.example/", "https://127.0.0.1/", "pipeline", "/a\\b", "javascript:1"]) {
      expect(() => buildUrl(3100, bad), bad).toThrow();
    }
    expect(() => buildUrl(0, "/")).toThrow();
    expect(isLocalUrl("http://localhost:3100/x")).toBe(true);
    expect(isLocalUrl("http://127.0.0.1/x")).toBe(true);
    expect(isLocalUrl("https://fonts.googleapis.com/css")).toBe(false);
    expect(isLocalUrl("http://localhost:3100/x", 3100)).toBe(true);
    expect(isLocalUrl("http://localhost:9999/x", 3100)).toBe(false);
    expect(isLocalUrl("http://127.0.0.1.evil.example/")).toBe(false);
  });

  it("refuses --out under /tmp, the Argus profile and Chrome profiles", () => {
    const home = "/home/u";
    expect(outDirProblem("/tmp/x", home)).toContain("/tmp");
    expect(outDirProblem("/tmp", home)).toContain("/tmp");
    expect(outDirProblem("/home/u/.local/share/argus/chrome/shots", home)).toContain("Argus");
    expect(outDirProblem("/home/u/.config/google-chrome/Default", home)).toContain("profile");
    expect(outDirProblem("/home/u/.config/chromium", home)).toContain("profile");
    expect(outDirProblem("/var/tmp/page-check", home)).toBeNull();
    expect(outDirProblem("/tmpfoo/x", home)).toBeNull();
  });

  it("names files by slug and picks the default out dir", () => {
    expect(slugFor("/")).toBe("home");
    expect(slugFor("/pipeline")).toBe("pipeline");
    expect(slugFor("/narratives/4?x=1")).toBe("narratives-4");
    expect(fileNames("pipeline")).toEqual({
      screenshots: { 1240: "pipeline-1240.png", 390: "pipeline-390.png" },
      keyScreenshots: { 1240: "pipeline-1240-keys.png", 390: "pipeline-390-keys.png" },
      json: "pipeline.json",
    });
    expect(outBase({ TMPDIR: "/var/tmp" })).toBe("/var/tmp/page-check");
    expect(outBase({})).toBe("/var/tmp/page-check");
  });

  it("gives every run its own folder under the base", () => {
    const base = path.join(tempDir("page-check-base-"), "page-check");
    const a = makeRunDir(base);
    const b = makeRunDir(base);
    expect(a).not.toBe(b);
    expect(path.dirname(a)).toBe(base);
    expect(path.basename(a)).toMatch(/^run-[A-Za-z0-9]{6}$/);
    fs.writeFileSync(path.join(a, "home-1240.png"), "a");
    fs.writeFileSync(path.join(b, "home-1240.png"), "b");
    expect(fs.readFileSync(path.join(a, "home-1240.png"), "utf8")).toBe("a");
  });

  it("caps old run folders and never removes the current one", () => {
    const base = tempDir("page-check-base-");
    const old = Array.from({ length: 6 }, (_, i) => {
      const d = path.join(base, `run-old${i}`);
      fs.mkdirSync(d);
      const t = new Date(Date.now() - (100 - i) * 60000); // old0 oldest
      fs.utimesSync(d, t, t);
      return d;
    });
    const unrelated = path.join(base, "keep-me");
    fs.mkdirSync(unrelated);
    const current = path.join(base, "run-current");
    fs.mkdirSync(current);
    const oldest = new Date(0);
    fs.utimesSync(current, oldest, oldest); // even the oldest by time, the current run stays
    const removed = pruneRuns(base, current, 3);
    expect(fs.existsSync(current)).toBe(true);
    expect(fs.existsSync(unrelated)).toBe(true);
    expect(removed.sort()).toEqual(["run-old0", "run-old1", "run-old2", "run-old3"]);
    expect(old.filter((d) => fs.existsSync(d))).toEqual([old[4], old[5]]);
    expect(KEEP_RUNS).toBeGreaterThan(1);
  });

  it("asks the OS for a free port, never the live one, and two asks held open differ", async () => {
    const servers: net.Server[] = [];
    const ports: number[] = [];
    for (let i = 0; i < 2; i++) {
      const p: number = await freePort();
      ports.push(p);
      const s = net.createServer();
      await new Promise<void>((resolve) => s.listen(p, "127.0.0.1", resolve)); // free means it can be taken
      servers.push(s);
    }
    await Promise.all(servers.map((s) => new Promise<void>((resolve) => s.close(() => resolve()))));
    expect(ports[0]).not.toBe(ports[1]);
    for (const p of ports) expect(p).not.toBe(3100);
  });

  it("parses arguments", () => {
    expect(parseArgs(["/pipeline", "--port", "3200", "--out", "/x", "--keys", "Tab", "--watch", "a", "--watch", "b"])).toMatchObject({ path: "/pipeline", port: 3200, out: "/x", keys: "Tab", watch: ["a", "b"] });
    expect(parseArgs([])).toMatchObject({ path: "/", port: 3100 });
    expect(() => parseArgs(["--bogus"])).toThrow();
    expect(() => parseArgs(["/a", "/b"])).toThrow();
    expect(() => parseArgs(["--port"])).toThrow();
  });
});

describe("page-check pass/fail decision", () => {
  it("passes a healthy page", () => {
    expect(decide(healthy)).toEqual({ exit: 0, reasons: [], warnings: [] });
  });

  it("fails on a non-2xx status, a console error, a page error and a failed local request", () => {
    expect(decide({ ...healthy, widths: [{ ...healthy.widths[0], status: 404 }, healthy.widths[1]] }).exit).toBe(1);
    expect(decide({ ...healthy, consoleErrors: ["boom"] }).reasons).toEqual(["console error: boom"]);
    expect(decide({ ...healthy, pageErrors: ["x is not defined"] }).exit).toBe(1);
    expect(decide({ ...healthy, failedRequests: ["404 http://127.0.0.1/a.png"] }).exit).toBe(1);
  });

  it("only warns on overflow unless the page opted into failing", () => {
    const over = { ...healthy, widths: [healthy.widths[0], { width: 390, status: 200, scrollWidth: 900, overflow: true }] };
    const warned = decide(over);
    expect(warned.exit).toBe(0);
    expect(warned.warnings[0]).toContain("horizontal overflow");
    expect(decide(over, { failOnOverflow: true }).exit).toBe(1);
  });
});

describe("page-check browser choice", () => {
  const exe = (rev: string) => path.join("chromium_headless_shell-" + rev, "chrome-headless-shell-linux64", "chrome-headless-shell");
  const fake = (...revs: string[]) => {
    const dir = tempDir("page-check-cache-");
    for (const r of revs) {
      fs.mkdirSync(path.join(dir, path.dirname(exe(r))), { recursive: true });
      fs.writeFileSync(path.join(dir, exe(r)), "");
    }
    return dir;
  };

  it("picks the expected revision, never another, and returns null when it is missing", () => {
    expect(chooseBrowser(fake("1254"), "1254")?.path).toContain("chromium_headless_shell-1254");
    expect(chooseBrowser(fake("1194", "1254"), "1254")?.revision).toBe("1254");
    expect(chooseBrowser(fake("1194"), "1254")).toBeNull();
    expect(chooseBrowser(path.join(fake(), "missing"), "1254")).toBeNull();
  });
});

describe("page-check key script", () => {
  it("accepts focus/open/close keys and focus=<selector>, rejects anything else", () => {
    expect(parseKeys("Tab, enter,Escape,Shift+Tab,focus=[data-test=x]").map((s: { label: string }) => s.label)).toEqual(["Tab", "Enter", "Escape", "Shift+Tab", "focus [data-test=x]"]);
    expect(parseKeys("")).toEqual([]);
    for (const bad of ["a", "Control+v", "Delete", "Backspace", "Meta+Enter", "click=button", "focus="]) {
      expect(() => parseKeys(bad), bad).toThrow();
    }
  });
});
