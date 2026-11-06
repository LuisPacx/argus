import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { Datastore } from "./datastore.ts";
import { ingestSources } from "./ingest.ts";
import type { Signal, Source } from "./sources/source.ts";
import { tempDir } from "./testing/temp.ts";

const T0 = new Date("2026-06-14T10:00:00.000Z");
const at = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);
const sig = (n: number, sourceId = "rss:a"): Signal => ({
  id: `${sourceId}:${n}`,
  sourceId,
  sourceLabel: sourceId.toUpperCase(),
  title: `t${n}`,
  summary: "",
  url: `https://e.example/${n}`,
  publishedAt: "2026-06-14T09:00:00.000Z",
});
const source = (id: string, poll: Source["poll"]): Source => ({ id, label: id.toUpperCase(), poll });
const failing = (message: string) => async (): Promise<Signal[]> => {
  throw new Error(message);
};

describe("source health in the Datastore", () => {
  it("a Source that fails and then succeeds ends with no error and both times set", () => {
    const ds = Datastore.open(":memory:");
    ds.recordSourcePoll({ sourceId: "rss:a", label: "A", error: "HTTP 503" }, at(0));
    expect(ds.sourceHealth(at(1))).toEqual([
      { sourceId: "rss:a", label: "A", lastPolledAt: at(0).toISOString(), lastOkAt: null, lastError: "HTTP 503", lastErrorAt: at(0).toISOString(), signals24h: 0 },
    ]);
    ds.recordSourcePoll({ sourceId: "rss:a", label: "A" }, at(10));
    expect(ds.sourceHealth(at(11))).toEqual([
      { sourceId: "rss:a", label: "A", lastPolledAt: at(10).toISOString(), lastOkAt: at(10).toISOString(), lastError: null, lastErrorAt: null, signals24h: 0 },
    ]);
  });

  it("a failure after a success keeps lastOkAt and records the error", () => {
    const ds = Datastore.open(":memory:");
    ds.recordSourcePoll({ sourceId: "rss:a", label: "A" }, at(0));
    ds.recordSourcePoll({ sourceId: "rss:a", label: "A", error: "timeout" }, at(10));
    expect(ds.sourceHealth(at(11))).toEqual([
      { sourceId: "rss:a", label: "A", lastPolledAt: at(10).toISOString(), lastOkAt: at(0).toISOString(), lastError: "timeout", lastErrorAt: at(10).toISOString(), signals24h: 0 },
    ]);
  });

  it("counts Signals ingested in the rolling 24 h only, per Source, sorted by sourceId", () => {
    const ds = Datastore.open(":memory:");
    ds.recordSignals([sig(1, "rss:b"), sig(2, "rss:b")], at(0));
    ds.recordSignals([sig(3, "rss:a")], new Date(T0.getTime() - 25 * 3_600_000));
    ds.recordSignals([sig(4, "rss:a")], at(-60));
    ds.recordSourcePoll({ sourceId: "rss:b", label: "B" }, at(0));
    ds.recordSourcePoll({ sourceId: "rss:a", label: "A" }, at(0));
    expect(ds.sourceHealth(at(5)).map((s) => [s.sourceId, s.signals24h])).toEqual([
      ["rss:a", 1],
      ["rss:b", 2],
    ]);
  });

  it("lists a legacy Source that has Signals but no poll row, with lastPolledAt null", () => {
    const ds = Datastore.open(":memory:");
    ds.recordSignals([sig(1, "rss:old")], at(0));
    expect(ds.sourceHealth(at(1))).toEqual([
      { sourceId: "rss:old", label: "RSS:OLD", lastPolledAt: null, lastOkAt: null, lastError: null, lastErrorAt: null, signals24h: 1 },
    ]);
  });

  it("keeps the error short and free of query strings, fragments and credentials", () => {
    const ds = Datastore.open(":memory:");
    const long = `fetch https://user:pw@h.example/feed?token=SECRET#frag failed ${"x".repeat(400)}`;
    ds.recordSourcePoll({ sourceId: "rss:a", label: "A", error: long }, at(0));
    const err = ds.sourceHealth(at(1))[0]!.lastError!;
    expect(err.startsWith("fetch https://h.example/feed failed x")).toBe(true);
    expect(err.length).toBe(300);
    expect(err).not.toMatch(/SECRET|pw|frag/);
  });
});

describe("ingestSources records each poll", () => {
  it("records a success, a failure (message kept) and a zero-item Source, and one failure does not stop the others", async () => {
    const ds = Datastore.open(":memory:");
    const sources = [
      source("rss:ok", async () => [sig(1, "rss:ok")]),
      source("rss:bad", failing("RSS fetch failed: 503")),
      source("rss:quiet", async () => []),
    ];
    const lines: string[] = [];
    expect(await ingestSources(ds, sources, (l) => lines.push(l))).toEqual({ stored: 1, failed: 1 });
    const health = Object.fromEntries(ds.sourceHealth().map((h) => [h.sourceId, h]));
    expect(health["rss:ok"]).toMatchObject({ label: "RSS:OK", lastError: null, lastOkAt: expect.any(String), lastPolledAt: expect.any(String), signals24h: 1 });
    expect(health["rss:bad"]).toMatchObject({ lastError: "RSS fetch failed: 503", lastOkAt: null, lastErrorAt: expect.any(String), signals24h: 0 });
    expect(health["rss:quiet"]).toMatchObject({ lastError: null, lastOkAt: expect.any(String), signals24h: 0 });
  });

  it("a later failure keeps the earlier lastOkAt", async () => {
    const ds = Datastore.open(":memory:");
    let fail = false;
    const flaky = source("rss:flaky", async () => {
      if (fail) throw new Error("boom");
      return [];
    });
    await ingestSources(ds, [flaky], () => {});
    const ok = ds.sourceHealth()[0]!.lastOkAt;
    expect(ok).not.toBeNull();
    fail = true;
    await ingestSources(ds, [flaky], () => {});
    expect(ds.sourceHealth()[0]).toMatchObject({ lastOkAt: ok, lastError: "boom" });
  });
});

describe("poll bookkeeping never breaks the ingest pass", () => {
  it("a recordSourcePoll that throws is logged, and signals and the other Sources are still handled", async () => {
    const ds = Datastore.open(":memory:");
    const store = { recordSignals: ds.recordSignals.bind(ds), recordSourcePoll: () => { throw new Error("database is locked"); } };
    const lines: string[] = [];
    const sources = [source("rss:ok", async () => [sig(1, "rss:ok")]), source("rss:bad", failing("boom"))];
    await expect(ingestSources(store, sources, (l) => lines.push(l))).resolves.toEqual({ stored: 1, failed: 1 });
    expect(lines.filter((l) => l.includes("database is locked"))).toHaveLength(2);
  });
});

describe("poll error redaction", () => {
  const stored = (error: string) => {
    const ds = Datastore.open(":memory:");
    ds.recordSourcePoll({ sourceId: "s", label: "S", error });
    return ds.sourceHealth()[0]!.lastError!;
  };
  it.each([
    ["a Telegram-style path secret", "GET https://api.example/bot123:ABC-def/getUpdates failed", "bot123", "ABC-def"],
    ["a bearer credential", "401 with Authorization: Bearer abc.def.ghi rejected", "abc.def.ghi", "abc.def"],
    ["token= in prose", "bad request token=s3cr3t&x=1 refused", "s3cr3t", "s3cr3t"],
    ["key= in prose", "denied: api_key=hunter2 invalid", "hunter2", "hunter2"],
    ["userinfo in wss://", "connect wss://user:pw0rd@h.example/ws failed", "pw0rd", "user:"],
    ["userinfo in ftp://", "fetch ftp://user:pw0rd@h.example/f failed", "pw0rd", "user:"],
  ])("masks %s", (_name, message, secret, alsoGone) => {
    const out = stored(message);
    expect(out).not.toContain(secret);
    expect(out).not.toContain(alsoGone);
  });
  it("keeps the readable parts of a masked message", () => {
    expect(stored("GET https://api.example/bot123:ABC/getUpdates failed")).toBe("GET https://api.example/bot***/getUpdates failed");
    expect(stored("rejected Bearer abc.def")).toBe("rejected Bearer ***");
    expect(stored("bad token=s3cr3t now")).toBe("bad token=*** now");
    expect(stored("connect wss://u:p@h.example/ws failed")).toBe("connect wss://h.example/ws failed");
  });
});

describe("brain_runs.finished_at", () => {
  it("finishBrainRun, the stale sweep and recordBrainRun all set it; an open run has none", () => {
    const ds = Datastore.open(":memory:");
    const a = ds.startBrainRun({ proposalId: 0, task: "judge", backend: "claude-code", model: "m" }, at(0));
    const open = ds.startBrainRun({ proposalId: 0, task: "judge", backend: "claude-code", model: "m" }, at(0));
    const stale = ds.startBrainRun({ proposalId: 0, task: "propose", backend: "claude-code", model: "m" }, at(0));
    ds.finishBrainRun(a, { sessionId: null, totalCostUsd: 1, exitStatus: "success" });
    ds.finishBrainRun(open, { sessionId: null, totalCostUsd: 1, exitStatus: "success" });
    const open2 = ds.startBrainRun({ proposalId: 0, task: "judge", backend: "claude-code", model: "m" }, new Date());
    expect(ds.interruptStaleBrainRuns(() => 1000, new Date(Date.now() + 3_600_000))).toBe(2);
    ds.recordBrainRun({ proposalId: 0, task: "judge", backend: "api", model: "m", sessionId: null, totalCostUsd: 0.1, exitStatus: "failed" });
    const rows = ds.recentBrainRuns(10);
    expect(rows.map((r) => [r.id, r.status, r.finishedAt === null])).toEqual([
      [open2 + 1, "failed", false],
      [open2, "interrupted", false],
      [stale, "interrupted", false],
      [open, "success", false],
      [a, "success", false],
    ]);
    const live = ds.startBrainRun({ proposalId: 0, task: "judge", backend: "claude-code", model: "m" });
    expect(ds.recentBrainRuns(1)[0]).toMatchObject({ id: live, status: "in-flight", finishedAt: null });
  });
});

describe("migration against a database made by the previous schema", () => {
  it("adds source_polls and finished_at to a live DB, keeps its rows, and runs again harmlessly", () => {
    const path = join(tempDir("argus-polls-mig-"), "argus.db");
    const first = Datastore.open(path);
    first.recordSignals([sig(1)]);
    const id = first.startBrainRun({ proposalId: 0, task: "judge", backend: "claude-code", model: "m" }, at(0));
    first.finishBrainRun(id, { sessionId: null, totalCostUsd: 2, exitStatus: "success" });
    first.close();
    // Put the file back to what the worker before this change wrote: no source_polls, no finished_at.
    const raw = new DatabaseSync(path);
    raw.exec("DROP TABLE source_polls");
    raw.exec("ALTER TABLE brain_runs DROP COLUMN finished_at");
    raw.exec("UPDATE brain_runs SET exit_status = 'success'");
    raw.close();

    const ds = Datastore.open(path);
    expect(ds.recentBrainRuns(5)).toMatchObject([{ id, status: "success", estCostUsd: 2, finishedAt: null }]);
    expect(ds.sourceHealth().map((h) => [h.sourceId, h.lastPolledAt])).toEqual([["rss:a", null]]);
    ds.recordSourcePoll({ sourceId: "rss:a", label: "A" });
    ds.close();
    const again = Datastore.open(path);
    expect(again.sourceHealth()[0]!.lastPolledAt).not.toBeNull();
    again.close();
  });
});
