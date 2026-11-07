import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ClaudeCodeBrain, resolveRouting } from "./brain.ts";
import { Datastore } from "./datastore.ts";
import { type ProposalStatus } from "./lifecycle.ts";
import { RunCancels, draftPendingSpecs, draftSpec, reviseSpec } from "./spec-drafting.ts";
import { FAKE_CLAUDE } from "./testing/fake-claude.ts";
import { applyPending } from "./testing/apply.ts";
import { tempDir } from "./testing/temp.ts";
import { untilExists } from "./testing/wait.ts";

const SPEC = "# Cat Coin\n\nA cat page.\n\n## Goal\n\nSee cats.\n\n## Scope\n\n- Cats.\n\n## Acceptance criteria\n\n- [ ] Cats show.\n";
const HOUR = 3_600_000;
const input = { narrativeSummary: "n", techOneLiner: "t", whyNow: "w", name: "Cat Coin", ticker: "CAT", description: "d", evidenceLinks: [] as string[] };

function setup(mode = "success", routing = resolveRouting()) {
  const store = Datastore.open(":memory:");
  const dir = tempDir("argus-undo-");
  const started = join(dir, "started");
  const brain = new ClaudeCodeBrain({
    routing,
    killGraceMs: 200,
    command: FAKE_CLAUDE,
    env: { PATH: process.env.PATH, FAKE_CLAUDE_MODE: mode, FAKE_CLAUDE_RESULT: SPEC, FAKE_CLAUDE_STARTED: started },
    passEnv: ["FAKE_CLAUDE_MODE", "FAKE_CLAUDE_RESULT", "FAKE_CLAUDE_STARTED"],
  });
  const id = store.createProposal(input).id;
  return { store, dir, brain, id, started };
}

function shortlist(store: Datastore, id: number) {
  store.transition(id, "shortlisted", "operator");
}

/** Queues and applies an undo, returning the command as resolved. */
function undo(store: Datastore, id: number, opts: Parameters<typeof applyPending>[2] = {}) {
  const c = store.enqueueCommand(id, "undo-shortlist");
  applyPending(store, undefined, opts);
  return store.getCommand(c.id)!;
}

describe("Undo shortlist: the transition", () => {
  it("returns a shortlisted Proposal to new, as the Operator, and is not a Dismissal", () => {
    const { store, id } = setup();
    shortlist(store, id);
    expect(undo(store, id).status).toBe("applied");
    expect(store.getProposal(id)!.status).toBe("new");
    expect(store.historyFor(id).map((h) => `${h.from}>${h.to}:${h.actor}`)).toEqual([
      "null>new:system",
      "new>shortlisted:operator",
      "shortlisted>new:operator",
    ]);
    expect(store.historyFor(id).at(-1)!.reason).toBe("Operator undid the shortlist");
    expect(store.historyFor(id).some((h) => h.to === "dismissed")).toBe(false);
  });

  it("returns a spec-drafted Proposal to new, discarding the Spec: fields cleared, spec.md removed, any queued revision dropped", async () => {
    const { store, dir, brain, id } = setup();
    shortlist(store, id);
    await draftPendingSpecs(store, brain, dir, () => {});
    const drafted = store.getProposal(id)!;
    expect(drafted.status).toBe("spec-drafted");
    store.queueRevision(id, "more cats");
    expect(existsSync(drafted.specPath!)).toBe(true);

    expect(undo(store, id).status).toBe("applied");
    expect(store.getProposal(id)).toMatchObject({ status: "new", specPath: null, specHash: null, specError: "", specRetryAfter: null, specAttempts: 0, specRevision: null });
    expect(existsSync(drafted.specPath!)).toBe(false);
    expect(store.historyFor(id).at(-1)).toMatchObject({ from: "spec-drafted", to: "new", actor: "operator" });
    // The spent run stays on the card: undoing does not give the money back.
    expect(store.brainRunsFor(id)).toMatchObject([{ task: "spec", exitStatus: "success" }]);
  });

  it("clears a failed draft's error so a later shortlist starts clean", () => {
    const { store, id } = setup();
    shortlist(store, id);
    store.failSpec(id, "Spec draft failed: x", { rateLimited: true, backoffMs: 1000 });
    undo(store, id);
    expect(store.getProposal(id)).toMatchObject({ status: "new", specError: "", specRetryAfter: null, specAttempts: 0 });
  });

  it("is a no-op on a Proposal that is already new (a double click), and is refused from any other status", () => {
    const { store, id } = setup();
    expect(undo(store, id).status).toBe("applied");
    expect(store.historyFor(id)).toHaveLength(1);

    const refused: ProposalStatus[] = ["approved", "building", "built", "build-failed", "needs-human", "launched", "closed", "dismissed"];
    const walks: Record<string, Array<[ProposalStatus, "operator" | "system" | "build"]>> = {
      approved: [["shortlisted", "operator"], ["spec-drafted", "system"], ["approved", "operator"]],
      building: [["shortlisted", "operator"], ["spec-drafted", "system"], ["approved", "operator"], ["building", "build"]],
      built: [["shortlisted", "operator"], ["spec-drafted", "system"], ["approved", "operator"], ["building", "build"], ["built", "build"]],
      "build-failed": [["shortlisted", "operator"], ["spec-drafted", "system"], ["approved", "operator"], ["building", "build"], ["build-failed", "build"]],
      "needs-human": [["shortlisted", "operator"], ["spec-drafted", "system"], ["approved", "operator"], ["needs-human", "build"]],
      launched: [["shortlisted", "operator"], ["spec-drafted", "system"], ["approved", "operator"], ["building", "build"], ["built", "build"], ["launched", "operator"]],
      closed: [["closed", "system"]],
      dismissed: [["dismissed", "operator"]],
    };
    for (const status of refused) {
      const other = store.createProposal({ ...input, name: `P ${status}` }).id;
      for (const [to, actor] of walks[status]!) store.transition(other, to, actor);
      const c = undo(store, other);
      expect(c.status, status).toBe("rejected");
      expect(c.error, status).toContain("Undo shortlist");
      expect(store.getProposal(other)!.status, status).toBe(status);
    }
  });
});

describe("Undo shortlist: expiry counts from creation", () => {
  it("a new Proposal that was shortlisted and undone still expires 48 h after it was created", () => {
    const { store, id } = setup();
    const created = store.getProposal(id)!;
    shortlist(store, id);
    undo(store, id);
    const p = store.getProposal(id)!;
    expect(p.status).toBe("new");
    expect(p.expiresAt).toBe(new Date(new Date(created.createdAt).getTime() + 48 * HOUR).toISOString());
  });
});

describe("Undo shortlist: a Spec run in flight", () => {
  it("cancels the draft: the run is recorded cancelled with the spend it reported, and nothing is written for the Proposal", async () => {
    const { store, dir, brain, id, started } = setup("hang-report", resolveRouting({ spec: { timeoutMs: 60_000 } }));
    shortlist(store, id);
    const cancels = new RunCancels();
    const drafting = draftSpec(store, brain, store.getProposal(id)!, dir, undefined, cancels);
    await untilExists(started); // the child has installed its SIGTERM handler; aborting earlier would kill it before it can report
    expect(store.getProposal(id)!.brainRunInFlightSince).not.toBeNull();

    // The worker applies the command while the run is in flight.
    expect(undo(store, id, { cancelRun: (pid) => cancels.cancel(pid) }).status).toBe("applied");
    expect(await drafting).toBe(false);

    expect(store.getProposal(id)).toMatchObject({ status: "new", specError: "", specPath: null, brainRunInFlightSince: null, agentCostUsd: 0.004 });
    expect(store.brainRunsFor(id)).toMatchObject([{ task: "spec", exitStatus: "cancelled", totalCostUsd: 0.004, sessionId: "5e55a0a0-0000-4000-8000-000000000001" }]);
    expect(existsSync(join(dir, "proposals", String(id), "spec.md"))).toBe(false);
    // Not drafted again.
    expect(await draftPendingSpecs(store, brain, dir, () => {}, undefined, cancels)).toBe(0);
    expect(store.brainRunsFor(id)).toHaveLength(1);
  });

  it("cancels a run that reported nothing as cancelled with zero spend", async () => {
    const { store, dir, brain, id, started } = setup("hang", resolveRouting({ spec: { timeoutMs: 60_000 } }));
    shortlist(store, id);
    const cancels = new RunCancels();
    const drafting = draftSpec(store, brain, store.getProposal(id)!, dir, undefined, cancels);
    await untilExists(started);
    undo(store, id, { cancelRun: (pid) => cancels.cancel(pid) });
    await drafting;
    expect(store.brainRunsFor(id)).toMatchObject([{ exitStatus: "cancelled", totalCostUsd: 0 }]);
    expect(store.getProposal(id)).toMatchObject({ status: "new", specError: "" });
  });

  it("a worker shutdown during a run is still interrupted, not cancelled", async () => {
    const { store, dir, brain, id, started } = setup("hang", resolveRouting({ spec: { timeoutMs: 60_000 } }));
    shortlist(store, id);
    const ac = new AbortController();
    const drafting = draftSpec(store, brain, store.getProposal(id)!, dir, ac.signal, new RunCancels());
    await untilExists(started);
    ac.abort();
    await drafting;
    expect(store.brainRunsFor(id)).toMatchObject([{ exitStatus: "interrupted" }]);
    expect(store.getProposal(id)!.status).toBe("shortlisted");
  });

  it("cancels a Spec revise in flight and drops the queued instruction", async () => {
    const { store, dir, brain, id } = setup();
    shortlist(store, id);
    await draftPendingSpecs(store, brain, dir, () => {});
    const hanging = new ClaudeCodeBrain({
      routing: resolveRouting({ spec: { timeoutMs: 60_000 } }),
      killGraceMs: 200,
      command: FAKE_CLAUDE,
      env: { PATH: process.env.PATH, FAKE_CLAUDE_MODE: "hang-report", FAKE_CLAUDE_STARTED: join(dir, "started2") },
      passEnv: ["FAKE_CLAUDE_MODE", "FAKE_CLAUDE_STARTED"],
    });
    store.queueRevision(id, "more cats");
    const cancels = new RunCancels();
    const revising = reviseSpec(store, hanging, store.getProposal(id)!, dir, undefined, cancels);
    await untilExists(join(dir, "started2"));
    undo(store, id, { cancelRun: (pid) => cancels.cancel(pid) });
    expect(await revising).toBe(false);
    expect(store.getProposal(id)).toMatchObject({ status: "new", specRevision: null, specPath: null, specError: "" });
    expect(store.brainRunsFor(id).map((r) => `${r.task}:${r.exitStatus}`)).toEqual(["spec:success", "spec-revise:cancelled"]);
  });
});

describe("Undo shortlist: the race with a completing run", () => {
  it("an undo that lands just as the run finishes leaves the Proposal new: not flipped to spec-drafted, no spec.md, spend recorded", async () => {
    const { store, dir, brain, id } = setup("success");
    shortlist(store, id);
    // The undo is applied after the brain returned its output and before the draft is stored: the exact window.
    const racing = {
      routeFor: (t: string) => brain.routeFor(t as "spec"),
      run: (async (...args: Parameters<typeof brain.run>) => {
        const run = await brain.run(...args);
        undo(store, id);
        return run;
      }) as typeof brain.run,
    };
    expect(await draftSpec(store, racing, store.getProposal(id)!, dir)).toBe(false);
    expect(store.getProposal(id)).toMatchObject({ status: "new", specPath: null, specHash: null, specError: "" });
    expect(existsSync(join(dir, "proposals", String(id), "spec.md"))).toBe(false);
    expect(store.brainRunsFor(id)).toMatchObject([{ exitStatus: "success", totalCostUsd: 0.0123 }]);
  });

  it("an undo that lands between the status check and the transition is refused by the transition, and the written spec.md is removed", async () => {
    const { store, dir, brain, id } = setup("success");
    shortlist(store, id);
    // Undo runs inside the store call that completes the Spec, ahead of its own transaction: the check passed, the write is done.
    const real = store.completeSpec.bind(store);
    store.completeSpec = (pid, spec) => {
      undo(store, pid);
      real(pid, spec);
    };
    expect(await draftSpec(store, brain, store.getProposal(id)!, dir)).toBe(false);
    expect(store.getProposal(id)).toMatchObject({ status: "new", specPath: null, specHash: null });
    expect(existsSync(join(dir, "proposals", String(id), "spec.md"))).toBe(false);
  });

  it("completeSpec itself refuses a Proposal that is no longer shortlisted and changes nothing", () => {
    const { store, id } = setup();
    shortlist(store, id);
    undo(store, id);
    expect(() => store.completeSpec(id, { path: "/x/spec.md", hash: "h" })).toThrow();
    expect(store.getProposal(id)).toMatchObject({ status: "new", specPath: null, specHash: null });
  });
});
