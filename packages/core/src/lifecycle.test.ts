import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { tempDir } from "./testing/temp.ts";
import { buildHomeFor, nextBuildable } from "./build-runner.ts";
import { Datastore, type WarRoomStore } from "./datastore.ts";
import {
  IllegalTransitionError,
  TRANSITIONS,
  approve,
  applyPendingCommands,
  findTransition,
  DomainError,
  type ProposalStatus,
} from "./lifecycle.ts";

const input = {
  narrativeSummary: "n",
  techOneLiner: "t",
  whyNow: "w",
  name: "Cat Coin",
  ticker: "CAT",
  description: "d",
  evidenceLinks: [],
};

const ALL: ProposalStatus[] = [
  "new", "shortlisted", "spec-drafted", "approved", "building", "built",
  "build-failed", "needs-human", "launched", "closed", "dismissed",
];

/** Walks a Proposal to `status` along legal transitions. */
function proposalAt(ds: Datastore, status: ProposalStatus) {
  const paths: Record<string, [ProposalStatus, "operator" | "system" | "build"][]> = {
    new: [],
    shortlisted: [["shortlisted", "operator"]],
    "spec-drafted": [["shortlisted", "operator"], ["spec-drafted", "system"]],
    approved: [["shortlisted", "operator"], ["spec-drafted", "system"], ["approved", "operator"]],
    building: [["shortlisted", "operator"], ["spec-drafted", "system"], ["approved", "operator"], ["building", "build"]],
    built: [["shortlisted", "operator"], ["spec-drafted", "system"], ["approved", "operator"], ["building", "build"], ["built", "build"]],
    "build-failed": [["shortlisted", "operator"], ["spec-drafted", "system"], ["approved", "operator"], ["building", "build"], ["build-failed", "build"]],
    "needs-human": [["shortlisted", "operator"], ["spec-drafted", "system"], ["approved", "operator"], ["needs-human", "build"]],
    launched: [["shortlisted", "operator"], ["spec-drafted", "system"], ["approved", "operator"], ["building", "build"], ["built", "build"], ["launched", "operator"]],
    closed: [["closed", "system"]],
    dismissed: [["dismissed", "operator"]],
  };
  const p = ds.createProposal(input);
  for (const [to, actor] of paths[status]!) ds.transition(p.id, to, actor);
  return p.id;
}

describe("transition table", () => {
  it("has the section 3 transitions", () => {
    const pairs = TRANSITIONS.filter((t) => t.to !== "dismissed").map((t) => `${t.from}>${t.to}:${t.actor}`);
    expect(pairs.sort()).toEqual(
      [
        "new>shortlisted:operator", "shortlisted>spec-drafted:system", "spec-drafted>approved:operator",
        "spec-drafted>approved:system",
        "approved>building:build", "approved>needs-human:build", "building>built:build",
        "building>build-failed:build", "building>needs-human:build", "built>launched:operator",
        "launched>closed:operator", "new>closed:system", "shortlisted>closed:system",
        "build-failed>approved:operator",
      ].sort(),
    );
  });

  it("allows dismiss from every state except closed (and dismissed)", () => {
    for (const s of ALL) {
      expect(!!findTransition(s, "dismissed", "operator")).toBe(s !== "closed" && s !== "dismissed");
    }
  });

  it("each legal transition applies and is recorded with actor and reason", () => {
    for (const t of TRANSITIONS) {
      const ds = Datastore.open(":memory:");
      const id = proposalAt(ds, t.from);
      ds.transition(id, t.to, t.actor, "because");
      expect(ds.getProposal(id)!.status).toBe(t.to);
      const last = ds.historyFor(id).at(-1)!;
      expect(last).toMatchObject({ from: t.from, to: t.to, actor: t.actor, reason: "because" });
      expect(last.at).toMatch(/^\d{4}-/);
    }
  });

  it("rejects every transition not in the table", () => {
    for (const from of ALL) {
      for (const to of ALL) {
        for (const actor of ["operator", "system", "build"] as const) {
          if (findTransition(from, to, actor)) continue;
          const ds = Datastore.open(":memory:");
          const id = proposalAt(ds, from);
          expect(() => ds.transition(id, to, actor)).toThrow(IllegalTransitionError);
          expect(ds.getProposal(id)!.status).toBe(from);
        }
      }
    }
  });

  it("uses the default reason when none is given", () => {
    const ds = Datastore.open(":memory:");
    const p = ds.createProposal(input);
    ds.transition(p.id, "shortlisted", "operator");
    expect(ds.historyFor(p.id).at(-1)!.reason).toBe("Operator shortlisted");
  });
});

describe("approve", () => {
  it("is the approval path: spec-drafted -> approved only", () => {
    const ds = Datastore.open(":memory:");
    const id = proposalAt(ds, "spec-drafted");
    approve(ds, id);
    expect(ds.getProposal(id)!.status).toBe("approved");
    const fresh = proposalAt(ds, "new");
    expect(() => approve(ds, fresh)).toThrow(IllegalTransitionError);
  });

  it("can be called by the system (phase 3 score threshold)", () => {
    const ds = Datastore.open(":memory:");
    const id = proposalAt(ds, "spec-drafted");
    approve(ds, id, "system");
    expect(ds.getProposal(id)!.status).toBe("approved");
    expect(ds.historyFor(id).at(-1)).toMatchObject({ actor: "system", reason: "Score threshold" });
  });
});

describe("command channel", () => {
  it("applies shortlist and dismiss, once", () => {
    const ds = Datastore.open(":memory:");
    const a = ds.createProposal(input).id;
    const b = ds.createProposal({ ...input, name: "Dog" }).id;
    ds.enqueueCommand(a, "shortlist");
    ds.enqueueCommand(b, "dismiss", "boring");
    expect(ds.getProposal(a)!.status).toBe("new");
    expect(applyPendingCommands(ds)).toBe(2);
    expect(applyPendingCommands(ds)).toBe(0);
    expect(ds.getProposal(a)!.status).toBe("shortlisted");
    expect(ds.getProposal(b)!.status).toBe("dismissed");
    expect(ds.historyFor(b).at(-1)).toMatchObject({ actor: "operator", reason: "boring" });
    expect(ds.listCommands().every((c) => c.status === "applied")).toBe(true);
  });

  it("marks illegal commands rejected with the error, leaving status and history alone", () => {
    const ds = Datastore.open(":memory:");
    const id = ds.createProposal(input).id;
    const c = ds.enqueueCommand(id, "approve");
    applyPendingCommands(ds);
    const after = ds.getCommand(c.id)!;
    expect(after.status).toBe("rejected");
    expect(after.error).toContain("new -> approved");
    expect(ds.getProposal(id)!.status).toBe("new");
    expect(ds.historyFor(id)).toHaveLength(1);
  });

  it("rejects dismiss without a reason and dismiss out of closed", () => {
    const ds = Datastore.open(":memory:");
    const id = ds.createProposal(input).id;
    const noReason = ds.enqueueCommand(id, "dismiss", "  ");
    applyPendingCommands(ds);
    expect(ds.getCommand(noReason.id)!.status).toBe("rejected");
    const closed = proposalAt(ds, "closed");
    const c = ds.enqueueCommand(closed, "dismiss", "x");
    applyPendingCommands(ds);
    expect(ds.getCommand(c.id)!.status).toBe("rejected");
    expect(ds.getProposal(closed)!.status).toBe("closed");
  });

  it("rejects a command for a missing Proposal", () => {
    const ds = Datastore.open(":memory:");
    const c = ds.enqueueCommand(42, "shortlist");
    applyPendingCommands(ds);
    expect(ds.getCommand(c.id)).toMatchObject({ status: "rejected", error: "Proposal 42 not found" });
  });
});

describe("re-queue from build-failed", () => {
  it("puts a build-failed Proposal back in the Build queue, behind the ones already waiting", async () => {
    const ds = Datastore.open(":memory:");
    const failed = proposalAt(ds, "build-failed");
    const waiting = proposalAt(ds, "approved");
    await new Promise((r) => setTimeout(r, 5)); // approval times are the queue order, to the millisecond
    const c = ds.enqueueCommand(failed, "requeue");
    expect(applyPendingCommands(ds)).toBe(1);
    expect(ds.getCommand(c.id)!.status).toBe("applied");
    expect(ds.getProposal(failed)!.status).toBe("approved");
    expect(ds.historyFor(failed).at(-1)).toMatchObject({ from: "build-failed", to: "approved", actor: "operator", reason: "Operator re-queued" });
    expect(nextBuildable(ds)!.id).toBe(waiting);
  });

  it("is refused from every other status, and a plain approve is refused from build-failed", () => {
    for (const status of ALL.filter((s) => s !== "build-failed" && s !== "approved")) {
      const ds = Datastore.open(":memory:");
      const id = proposalAt(ds, status);
      const c = ds.enqueueCommand(id, "requeue");
      applyPendingCommands(ds);
      expect(ds.getCommand(c.id)!.status, status).toBe("rejected");
      expect(ds.getProposal(id)!.status).toBe(status);
    }
    const ds = Datastore.open(":memory:");
    const id = proposalAt(ds, "build-failed");
    const c = ds.enqueueCommand(id, "approve");
    applyPendingCommands(ds);
    expect(ds.getCommand(c.id)).toMatchObject({ status: "rejected" });
    expect(ds.getProposal(id)!.status).toBe("build-failed");
  });

  it("a second re-queue (a double click) is a no-op", () => {
    const ds = Datastore.open(":memory:");
    const id = proposalAt(ds, "build-failed");
    ds.enqueueCommand(id, "requeue");
    ds.enqueueCommand(id, "requeue");
    applyPendingCommands(ds);
    expect(ds.listCommands().map((c) => c.status)).toEqual(["applied", "applied"]);
    expect(ds.historyFor(id).filter((e) => e.to === "approved")).toHaveLength(2); // once on the way to the failure, once re-queued
  });

  it("dismiss still works from build-failed", () => {
    const ds = Datastore.open(":memory:");
    const id = proposalAt(ds, "build-failed");
    ds.enqueueCommand(id, "dismiss", "not worth another try");
    applyPendingCommands(ds);
    expect(ds.getProposal(id)!.status).toBe("dismissed");
  });
});

describe("dismissal and the per-Build home", () => {
  /** A per-Build home with a session file in it, as a Build leaves one. */
  function withHome(dataDir: string, id: number) {
    const home = buildHomeFor(dataDir, id);
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(join(home, ".claude", "session.jsonl"), "{}\n");
    return home;
  }

  it("deletes the home of a build-failed Proposal when it is dismissed", () => {
    const dataDir = tempDir("argus-dismiss-");
    const ds = Datastore.open(":memory:");
    const id = proposalAt(ds, "build-failed");
    const home = withHome(dataDir, id);
    ds.enqueueCommand(id, "dismiss", "no");
    applyPendingCommands(ds, undefined, { dataDir });
    expect(ds.getProposal(id)!.status).toBe("dismissed");
    expect(existsSync(home)).toBe(false);
  });

  it("keeps the home of a build-failed Proposal that is not dismissed, and re-queueing does not delete it", () => {
    const dataDir = tempDir("argus-dismiss-");
    const ds = Datastore.open(":memory:");
    const id = proposalAt(ds, "build-failed");
    const home = withHome(dataDir, id);
    ds.enqueueCommand(id, "requeue");
    applyPendingCommands(ds, undefined, { dataDir });
    expect(existsSync(home)).toBe(true);
  });

  it("leaves the home of a Proposal that is building to the runner, which still has the container on it", () => {
    const dataDir = tempDir("argus-dismiss-");
    const ds = Datastore.open(":memory:");
    const id = proposalAt(ds, "building");
    const home = withHome(dataDir, id);
    ds.enqueueCommand(id, "dismiss", "no");
    applyPendingCommands(ds, undefined, { dataDir });
    expect(ds.getProposal(id)!.status).toBe("dismissed");
    expect(existsSync(home)).toBe(true);
  });

  it("deleting only the dismissed Proposal's home; another Proposal's stays", () => {
    const dataDir = tempDir("argus-dismiss-");
    const ds = Datastore.open(":memory:");
    const a = proposalAt(ds, "build-failed");
    const b = proposalAt(ds, "build-failed");
    withHome(dataDir, a);
    const keep = withHome(dataDir, b);
    ds.enqueueCommand(a, "dismiss", "no");
    applyPendingCommands(ds, undefined, { dataDir });
    expect(existsSync(keep)).toBe(true);
  });
});

describe("command error semantics", () => {
  it("applies a command whose target status is already current as a no-op", () => {
    const ds = Datastore.open(":memory:");
    const id = ds.createProposal(input).id;
    const first = ds.enqueueCommand(id, "shortlist");
    const second = ds.enqueueCommand(id, "shortlist");
    applyPendingCommands(ds);
    expect(ds.getCommand(first.id)!.status).toBe("applied");
    expect(ds.getCommand(second.id)).toMatchObject({ status: "applied", error: "" });
    expect(ds.historyFor(id)).toHaveLength(2);
    const d = ds.enqueueCommand(id, "dismiss", "meh");
    const d2 = ds.enqueueCommand(id, "dismiss", "meh");
    applyPendingCommands(ds);
    expect([ds.getCommand(d.id)!.status, ds.getCommand(d2.id)!.status]).toEqual(["applied", "applied"]);
    expect(ds.historyFor(id)).toHaveLength(3);
  });

  it("rejects only DomainErrors; a transient error leaves the command pending and rolls back", () => {
    const ds = Datastore.open(":memory:");
    const id = ds.createProposal(input).id;
    const c = ds.enqueueCommand(id, "shortlist");
    expect(() =>
      ds.resolveCommand(c.id, () => {
        ds.transition(id, "shortlisted", "operator");
        throw new Error("SQLITE_BUSY");
      }),
    ).toThrow("SQLITE_BUSY");
    expect(ds.getCommand(c.id)).toMatchObject({ status: "pending", error: "SQLITE_BUSY", attempts: 1 });
    expect(ds.getProposal(id)!.status).toBe("new");
    expect(ds.historyFor(id)).toHaveLength(1);
    ds.resolveCommand(c.id, () => {
      throw new DomainError("nope");
    });
    expect(ds.getCommand(c.id)).toMatchObject({ status: "rejected", error: "nope" });
  });

  it("a permanent non-domain error fails the command after 5 attempts; the next command is processed", () => {
    const path = join(tempDir("argus-"), "argus.db");
    const ds = Datastore.open(path);
    const id = ds.createProposal(input).id;
    const c = ds.enqueueCommand(id, "shortlist");
    const raw = new DatabaseSync(path);
    raw.exec(`CREATE TRIGGER boom BEFORE INSERT ON status_history WHEN NEW.to_status = 'shortlisted'
      BEGIN SELECT RAISE(ABORT, 'always broken'); END`);
    for (let i = 1; i <= 4; i++) {
      applyPendingCommands(ds, () => {});
      expect(ds.getCommand(c.id)).toMatchObject({ status: "pending", attempts: i, error: "always broken" });
    }
    applyPendingCommands(ds, () => {});
    expect(ds.getCommand(c.id)).toMatchObject({ status: "failed", attempts: 5, error: "always broken" });
    expect(ds.getCommand(c.id)!.appliedAt).not.toBeNull();
    expect(ds.pendingCommands()).toEqual([]);
    raw.exec("DROP TRIGGER boom");
    raw.close();
    expect(applyPendingCommands(ds)).toBe(0);
    expect(ds.getCommand(c.id)!.status).toBe("failed");
    const next = ds.enqueueCommand(id, "shortlist");
    expect(applyPendingCommands(ds)).toBe(1);
    expect(ds.getCommand(next.id)).toMatchObject({ status: "applied", attempts: 0 });
    expect(ds.getProposal(id)!.status).toBe("shortlisted");
  });

  it("a transient error that clears on attempt 2 is applied", () => {
    const ds = Datastore.open(":memory:");
    const id = ds.createProposal(input).id;
    const c = ds.enqueueCommand(id, "shortlist");
    let calls = 0;
    const flaky = () => {
      if (++calls === 1) throw new Error("blip");
      ds.transition(id, "shortlisted", "operator");
    };
    expect(() => ds.resolveCommand(c.id, flaky)).toThrow("blip");
    ds.resolveCommand(c.id, flaky);
    expect(ds.getCommand(c.id)).toMatchObject({ status: "applied", attempts: 1 });
    expect(ds.getProposal(id)!.status).toBe("shortlisted");
  });

  it("rejects a blank-reason dismiss even when already dismissed", () => {
    const ds = Datastore.open(":memory:");
    const id = ds.createProposal(input).id;
    ds.enqueueCommand(id, "dismiss", "meh");
    const blank = ds.enqueueCommand(id, "dismiss", "  ");
    applyPendingCommands(ds);
    expect(ds.getCommand(blank.id)).toMatchObject({ status: "rejected", error: "Dismissal requires a reason" });
    expect(ds.historyFor(id)).toHaveLength(2);
  });

  it("one failing command does not stop the batch, and is retried next tick", () => {
    const path = join(tempDir("argus-"), "argus.db");
    const ds = Datastore.open(path);
    const a = ds.createProposal(input).id;
    const b = ds.createProposal({ ...input, name: "Dog" }).id;
    const ca = ds.enqueueCommand(a, "shortlist");
    const cb = ds.enqueueCommand(b, "dismiss", "boring");
    // Inject a transient failure: any write of status `shortlisted` raises a SQLite error.
    const raw = new DatabaseSync(path);
    raw.exec(`CREATE TRIGGER boom BEFORE INSERT ON status_history WHEN NEW.to_status = 'shortlisted'
      BEGIN SELECT RAISE(ABORT, 'disk hiccup'); END`);
    const errors: number[] = [];
    expect(applyPendingCommands(ds, (c) => errors.push(c.id))).toBe(1);
    expect(errors).toEqual([ca.id]);
    expect(ds.getCommand(ca.id)!.status).toBe("pending");
    expect(ds.getProposal(a)!.status).toBe("new");
    expect(ds.getCommand(cb.id)!.status).toBe("applied");
    expect(ds.getProposal(b)!.status).toBe("dismissed");
    raw.exec("DROP TRIGGER boom");
    raw.close();
    expect(applyPendingCommands(ds)).toBe(1);
    expect(ds.getCommand(ca.id)!.status).toBe("applied");
    expect(ds.getProposal(a)!.status).toBe("shortlisted");
  });

  it("createProposal is atomic: a failing history insert leaves no Proposal", () => {
    const path = join(tempDir("argus-"), "argus.db");
    const ds = Datastore.open(path);
    const raw = new DatabaseSync(path);
    raw.exec("CREATE TRIGGER boom BEFORE INSERT ON status_history BEGIN SELECT RAISE(ABORT, 'nope'); END");
    expect(() => ds.createProposal(input)).toThrow("nope");
    expect(ds.listProposals()).toEqual([]);
    raw.close();
  });
});

describe("single writer", () => {
  it("the War Room store type has no status-writing methods", () => {
    const ds = Datastore.open(":memory:");
    const wr: WarRoomStore = ds;
    // @ts-expect-error transition is worker-only
    expect(wr.transition).toBeDefined();
    // @ts-expect-error resolveCommand is worker-only
    expect(wr.resolveCommand).toBeDefined();
  });

  it("the War Room never calls status-writing functions", () => {
    const root = join(import.meta.dirname, "../../../apps/warroom");
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        if (name === "node_modules" || name.startsWith(".")) continue;
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.(ts|vue)$/.test(name) && !name.endsWith(".test.ts")) files.push(p); // test seeding uses the full store
      }
    };
    walk(root);
    expect(files.length).toBeGreaterThan(0);
    const forbidden =
      /\b(transition|resolveCommand|applyCommand|applyPendingCommands|approve)\s*\(|UPDATE\s+(proposals|commands)\b|INSERT\s+INTO\s+status_history/i;
    for (const f of files) expect(readFileSync(f, "utf8"), f).not.toMatch(forbidden);
  });
});
