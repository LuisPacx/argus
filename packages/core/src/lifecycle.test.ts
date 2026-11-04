import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Datastore } from "./datastore.ts";
import {
  IllegalTransitionError,
  TRANSITIONS,
  approve,
  applyPendingCommands,
  findTransition,
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
        "approved>building:build", "approved>needs-human:build", "building>built:build",
        "building>build-failed:build", "building>needs-human:build", "built>launched:operator",
        "launched>closed:operator", "new>closed:system", "shortlisted>closed:system",
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

describe("single writer", () => {
  it("the War Room never calls status-writing functions", () => {
    const root = join(import.meta.dirname, "../../../apps/warroom");
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        if (name === "node_modules" || name.startsWith(".")) continue;
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.(ts|vue)$/.test(name)) files.push(p);
      }
    };
    walk(root);
    expect(files.length).toBeGreaterThan(0);
    const forbidden = /\b(transition|resolveCommand|applyCommand|applyPendingCommands|approve)\s*\(|UPDATE\s+proposals/;
    for (const f of files) expect(readFileSync(f, "utf8"), f).not.toMatch(forbidden);
  });
});
