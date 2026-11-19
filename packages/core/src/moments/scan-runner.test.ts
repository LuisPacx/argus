import { symlinkSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { tempDir } from "../testing/temp.ts";
import { parseChildOutput, spawnMomentRunner } from "./scan-runner.ts";

const line = (o: unknown) => `${JSON.stringify(o)}\n`;
const page = (over: Record<string, unknown> = {}) => ({ id: "top", url: "https://x.com/search?q=a&f=top", status: "ok", signals: [], httpStatus: 200, articleCount: 1, skipped: {}, ms: 5, posts: [{ statusId: "2123280111864811617", handle: "alice", text: "hi", hasVideo: true, counts: { replies: 1, reposts: 2, likes: 3, bookmarks: 4, views: 5 } }], ...over });

describe("parseChildOutput", () => {
  it("reads one JSON line per page and the last line", () => {
    const r = parseChildOutput(line(page()) + line(page({ id: "live" })) + line({ done: true, exit: 0, loads: 2, stopped: null }), 0);
    expect(r).toMatchObject({ kind: "ran", stopped: null, selectorsFoundNothing: false });
    expect(r.pages.map((p) => p.id)).toEqual(["top", "live"]);
    expect(r.pages[0]!.posts[0]).toEqual({ statusId: "2123280111864811617", handle: "alice", text: "hi", hasVideo: true, counts: { replies: 1, reposts: 2, likes: 3, bookmarks: 4, views: 5 } });
  });

  it("names a STOP signal from the last line, or from the exit code 2 and the page that carried it", () => {
    expect(parseChildOutput(line(page({ status: "login_wall", signals: ["login_wall"], posts: [] })) + line({ done: true, exit: 2, loads: 1, stopped: "login_wall" }), 2).stopped).toBe("login_wall");
    expect(parseChildOutput(line(page({ status: "challenge", signals: ["challenge"], posts: [] })) + line({ done: true, exit: 2, loads: 1 }), 2).stopped).toBe("challenge");
  });

  it("maps the exit codes: 3 is locked, 4 refused, 5 selectors found nothing", () => {
    expect(parseChildOutput(line({ done: true, exit: 3, loads: 0, reason: "held" }), 3)).toMatchObject({ kind: "locked", pages: [] });
    expect(parseChildOutput(line({ done: true, exit: 4, loads: 0, reason: "nope" }), 4)).toMatchObject({ kind: "refused", reason: "nope" });
    expect(parseChildOutput(line(page({ status: "selectors_found_nothing", posts: [] })) + line({ done: true, exit: 5, loads: 1 }), 5)).toMatchObject({ kind: "ran", selectorsFoundNothing: true });
  });

  it("a run with no last line is a failure, whatever the pages say", () => {
    expect(parseChildOutput(line(page()), null)).toMatchObject({ kind: "failed", reason: expect.stringContaining("without a result") });
    expect(parseChildOutput("", 1)).toMatchObject({ kind: "failed", pages: [] });
  });

  it("ignores lines that are not JSON or not objects, and cleans what it keeps: a figure that is not a count is null, a post without an ID is dropped", () => {
    const messy =
      "warning: something\n" + line(7) + line(null) + line(page({ posts: [{ statusId: 5, handle: "x" }, { statusId: "2123280111864811617", handle: "bob", text: 9, hasVideo: "yes", counts: { views: -1, likes: 1.5, replies: "7", reposts: 8, bookmarks: null } }] })) + line({ done: true, exit: 0 });
    const r = parseChildOutput(messy, 0);
    expect(r.pages).toHaveLength(1);
    expect(r.pages[0]!.posts).toEqual([{ statusId: "2123280111864811617", handle: "bob", text: "", hasVideo: false, counts: { replies: null, reposts: 8, likes: null, bookmarks: null, views: null } }]);
  });
});

describe("the real child process (no Chrome is opened: both runs end before the browser)", () => {
  const url = "https://x.com/search?q=gta&f=top";

  it("a held lock exits 3 with no load", async () => {
    const dir = tempDir("moment-chrome-");
    symlinkSync(`host-${process.pid}`, path.join(dir, "SingletonLock")); // this test process holds it
    const r = await spawnMomentRunner({ env: { ...process.env, ARGUS_CHROME_DIR: dir }, timeoutMs: 30_000 })([{ id: "top", url }]);
    expect(r).toMatchObject({ kind: "locked", pages: [] });
  }, 40_000);

  it("an address outside the allowed shapes is refused before the lock is even looked at", async () => {
    const dir = tempDir("moment-chrome-");
    symlinkSync(`host-${process.pid}`, path.join(dir, "SingletonLock"));
    const r = await spawnMomentRunner({ env: { ...process.env, ARGUS_CHROME_DIR: dir }, timeoutMs: 30_000 })([{ id: "a", url }, { id: "b", url: "https://x.com/someone" }]);
    expect(r).toMatchObject({ kind: "refused", pages: [], reason: expect.stringContaining("refused") });
  }, 40_000);

  it("a plan that is not JSON is refused", async () => {
    const r = await spawnMomentRunner({ timeoutMs: 30_000 })("not a list" as never);
    expect(r.kind).toBe("refused");
  }, 40_000);

  it("only a short list of environment names reaches the child (no token, no key)", async () => {
    // A script that prints the environment it was given, in place of the scanner.
    const script = path.join(tempDir("moment-env-"), "env.mjs");
    const { writeFileSync } = await import("node:fs");
    writeFileSync(script, 'process.stdout.write(JSON.stringify({ done: true, exit: 4, reason: Object.keys(process.env).sort().join(",") }) + "\\n");');
    const r = await spawnMomentRunner({ script, env: { PATH: process.env.PATH, HOME: "/h", TELEGRAM_BOT_TOKEN: "secret", ANTHROPIC_API_KEY: "secret", ARGUS_CHROME_DIR: "/d", ARGUS_DB: "/x.db" }, timeoutMs: 30_000 })([{ id: "top", url }]);
    expect(r.reason.split(",").sort()).toEqual(["ARGUS_CHROME_DIR", "HOME", "PATH"]);
  }, 40_000);

  it("a child that runs past the timeout is killed and reported as a failure", async () => {
    const script = path.join(tempDir("moment-slow-"), "slow.mjs");
    const { writeFileSync } = await import("node:fs");
    writeFileSync(script, "setInterval(() => {}, 1000);");
    const r = await spawnMomentRunner({ script, timeoutMs: 600 })([{ id: "top", url }]);
    expect(r).toMatchObject({ kind: "failed", reason: expect.stringContaining("ran past") });
  }, 40_000);
});
