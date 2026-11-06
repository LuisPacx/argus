import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildHomeFor, sweepDismissedHomes } from "./build-home.ts";
import { makeHarness, type Harness } from "./testing/build-harness.ts";

// Ticket 03 (hardening), items 3 and 4: the home of a Build dismissed before a crash is swept at the next start, and the lifecycle
// no longer reaches into the Build Runner.

const src = (name: string) => readFileSync(new URL(name, import.meta.url), "utf8");

describe("lifecycle.ts does not depend on build-runner.ts", () => {
  it("imports nothing from the Build Runner (the home helpers live in a module of their own, which the runner imports too)", () => {
    expect(src("./lifecycle.ts")).not.toMatch(/from\s+["']\.\/build-runner\.ts["']/);
    expect(src("./build-runner.ts")).toMatch(/from\s+["']\.\/build-home\.ts["']/);
  });
});

describe("sweepDismissedHomes: a dismissed Proposal's home is removed at worker start", () => {
  const withHome = (h: Harness, name: string, files: Record<string, string> = { ".claude/session.jsonl": "x", "locked/inner/f": "x" }) => {
    const p = h.seedApproved(name);
    const home = buildHomeFor(h.dataDir, p.id);
    for (const [f, text] of Object.entries(files)) {
      mkdirSync(join(home, f, ".."), { recursive: true });
      writeFileSync(join(home, f), text);
    }
    return { p, home };
  };

  it("removes the home of a dismissed Proposal (a mode-000 directory in it included), and only that one", () => {
    const h = makeHarness();
    const dismissed = withHome(h, "Cat Coin");
    const failed = withHome(h, "Dog Coin"); // build-failed keeps its home so the session can be resumed
    const approved = withHome(h, "Fish Coin");
    chmodSync(join(dismissed.home, "locked/inner"), 0o000);
    chmodSync(join(dismissed.home, "locked"), 0o000);
    h.store.transition(dismissed.p.id, "dismissed", "operator", "no thanks");
    h.store.beginBuild(failed.p.id, h.brain.routeFor("build"));
    h.store.transition(failed.p.id, "build-failed", "build", "failed");

    const lines: string[] = [];
    const removed = sweepDismissedHomes(h.store, h.dataDir, (l) => lines.push(l));

    expect(removed).toEqual([dismissed.home]);
    expect(existsSync(dismissed.home)).toBe(false);
    expect(existsSync(failed.home)).toBe(true);
    expect(existsSync(approved.home)).toBe(true);
    expect(lines.join("\n")).toContain(`removed the home of dismissed Proposal ${dismissed.p.id}`);
    expect(sweepDismissedHomes(h.store, h.dataDir)).toEqual([]); // nothing left to do the second time
  });

  it("leaves the home of a dismissed Proposal whose Build run is still alive (a --once worker beside the daemon), and sweeps it once the run has gone quiet", () => {
    const h = makeHarness();
    const { p, home } = withHome(h, "Cat Coin");
    const runId = h.store.beginBuild(p.id, h.brain.routeFor("build"));
    h.store.transition(p.id, "dismissed", "operator", "dismissed while building");
    const lines: string[] = [];
    const soon = new Date(Date.now() + 60_000);
    expect(sweepDismissedHomes(h.store, h.dataDir, (l) => lines.push(l), soon)).toEqual([]);
    expect(existsSync(home)).toBe(true);
    expect(lines.join("\n")).toContain("left alone");
    h.store.touchBrainRun(runId);
    // The run stopped beating (its worker crashed): once it is quiet for long enough the home is nobody's.
    const later = new Date(Date.now() + 30 * 60_000);
    expect(sweepDismissedHomes(h.store, h.dataDir, undefined, later)).toEqual([home]);
    expect(existsSync(home)).toBe(false);
  });

  it("a data dir with no proposals, or a dismissed Proposal with no home, is fine", () => {
    const h = makeHarness();
    expect(sweepDismissedHomes(h.store, h.dataDir)).toEqual([]);
    const p = h.seedApproved("Cat Coin");
    h.store.transition(p.id, "dismissed", "operator", "no thanks");
    expect(sweepDismissedHomes(h.store, h.dataDir)).toEqual([]);
  });
});
