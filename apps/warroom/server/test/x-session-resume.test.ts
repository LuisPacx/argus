import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { applyXSessionResumes, Datastore } from "@argus/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { tempDir } from "../../../../packages/core/src/testing/temp.ts";

/**
 * POST /api/x-session/resume (moment scanner ticket 01), the real route handler over a real store, called with what the button sends (nothing).
 * The War Room writes one insert-only request row and nothing else; the worker's tick applies it.
 */
let store: Datastore;
let file: string;
vi.stubGlobal("defineEventHandler", (f: unknown) => f);
vi.stubGlobal("createError", (o: { statusCode: number; statusMessage: string }) => Object.assign(new Error(o.statusMessage), o));
vi.stubGlobal("useStore", () => store);

const post = (await import("../api/x-session/resume.post.ts")).default as unknown as () => { id: number; status: string };
const moments = (await import("../api/moments.get.ts")).default as unknown as () => { session: { status: string } };
const status = async (f: () => unknown) => {
  try {
    await f();
    return 200;
  } catch (e) {
    return (e as { statusCode: number }).statusCode;
  }
};

/** Every row of every table, by table, so a change can be named. */
function tables(): Record<string, string> {
  const raw = new DatabaseSync(file);
  try {
    const names = (raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name != 'sqlite_sequence' ORDER BY name").all() as { name: string }[]).map((t) => t.name); // sqlite_sequence is SQLite's own counter of the table that grew
    return Object.fromEntries(names.map((t) => [t, JSON.stringify(raw.prepare(`SELECT * FROM "${t}"`).all())]));
  } finally {
    raw.close();
  }
}
const changed = (a: Record<string, string>, b: Record<string, string>) => Object.keys(b).filter((t) => a[t] !== b[t]);

beforeEach(() => {
  file = path.join(tempDir("warroom-resume-"), "argus.db");
  store = Datastore.open(file);
});
afterEach(() => store.close());

describe("POST /api/x-session/resume", () => {
  it("on a stopped state writes one request row, and only that table changes; the worker clears the state on its next tick", async () => {
    store.xSession.recordStop("login_wall", new Date());
    const before = tables();
    const r = post();
    expect(r).toEqual({ id: 1, status: "pending" });
    expect(changed(before, tables())).toEqual(["x_session_resume_requests"]);
    expect(store.xSession.resumeRequests()).toHaveLength(1);
    expect(store.xSession.state(new Date()).status).toBe("stopped"); // the press alone clears nothing
    expect(moments().session.status).toBe("stopped");
    // the worker's tick
    expect(applyXSessionResumes(store, new Date())).toBe(true);
    expect(store.xSession.state(new Date()).status).toBe("ok");
    expect(moments().session.status).toBe("ok");
  });

  it("when the state is ok it is refused with 409 and writes nothing", async () => {
    const before = tables();
    expect(await status(post)).toBe(409);
    expect(tables()).toEqual(before);
    expect(store.xSession.resumeRequests()).toEqual([]);
  });

  it("every press is recorded, even a second one while the first waits", async () => {
    store.xSession.recordStop("rate_limited", new Date());
    post();
    post();
    expect(store.xSession.resumeRequests()).toHaveLength(2);
    expect(await status(post)).toBe(200);
    expect(store.xSession.resumeRequests()).toHaveLength(3);
  });

  it("takes no input: whatever a caller sends, only a request row is written", async () => {
    store.xSession.recordStop("locked", new Date());
    const before = tables();
    (post as unknown as (e: unknown) => unknown)({ body: { status: "ok", reason: "", strikes: 0 } });
    expect(changed(before, tables())).toEqual(["x_session_resume_requests"]);
    expect(store.xSession.state(new Date())).toMatchObject({ status: "stopped", reason: "locked" });
  });
});

describe("a GET writes nothing", () => {
  it("/api/moments leaves every table as it was, stopped or not", () => {
    store.moments.recordScan({ at: new Date().toISOString(), topic: "GTA VI", status: "ok", loads: 2, signals: [], reason: "" });
    for (const stopped of [false, true]) {
      if (stopped) store.xSession.recordStop("challenge", new Date());
      const before = tables();
      moments();
      expect(tables()).toEqual(before);
    }
  });

  it("the page loads /api/moments with one GET and sends nothing else; only the Resume button posts, and only to the resume route", () => {
    const root = path.join(import.meta.dirname, "../../app");
    const page = readFileSync(path.join(root, "pages/moments.vue"), "utf8");
    expect(page.match(/useFetch\(/g)).toHaveLength(1);
    expect(page).toContain('useFetch("/api/moments"');
    expect(page).not.toMatch(/\$fetch|method:\s*["']POST|method:\s*["']PUT|method:\s*["']DELETE/);
    const panel = readFileSync(path.join(root, "components/MomentsPanel.vue"), "utf8");
    expect(panel.match(/\$fetch\(/g)).toHaveLength(1);
    expect(panel).toContain('$fetch("/api/x-session/resume", { method: "POST" })');
  });
});

describe("the War Room process writes no scanner table other than the request row", () => {
  it("no War Room source calls the scanner's or the session's write methods, and only the resume route presses Resume", () => {
    const walk = (dir: string, out: string[] = []): string[] => {
      for (const name of readdirSync(dir)) {
        if (name === "node_modules" || name.startsWith(".")) continue;
        const p = path.join(dir, name);
        if (statSync(p).isDirectory()) walk(p, out);
        else if (/\.(ts|vue)$/.test(name) && !name.endsWith(".test.ts")) out.push(p);
      }
      return out;
    };
    const files = walk(path.join(import.meta.dirname, "../.."));
    expect(files.length).toBeGreaterThan(20);
    const write = /\.(?:moments|xSession)\b|\brecordScan\b|\brecordPosts\b|\brecordStop\b|\bapplyResumes\b|\bapplyXSessionResumes\b|\bbeginProbe\b|\bclearOnCleanProbe\b|\bprobeNotClean\b|\brequestResume\b|\bcreateMomentJob\b/;
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      expect(write.test(src), `${path.relative(path.join(import.meta.dirname, "../.."), f)} touches the scanner's write side`).toBe(false);
    }
    const using = files.filter((f) => readFileSync(f, "utf8").includes("requestXSessionResume"));
    expect(using.map((f) => path.relative(path.join(import.meta.dirname, ".."), f))).toEqual(["api/x-session/resume.post.ts"]);
  });
});
