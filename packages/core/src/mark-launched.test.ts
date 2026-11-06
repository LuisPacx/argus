import { describe, expect, it } from "vitest";
import { Datastore } from "./datastore.ts";
import type { ProposalStatus } from "./lifecycle.ts";
// After datastore/lifecycle: the testing helper imports them back.
import { applyPending } from "./testing/apply.ts";

const MINT = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";
const input = { narrativeSummary: "n", techOneLiner: "t", whyNow: "w", name: "Cat", ticker: "CAT", description: "d", evidenceLinks: [] };

function proposalAt(ds: Datastore, status: "spec-drafted" | "built" | "launched") {
  const p = ds.createProposal(input);
  ds.transition(p.id, "shortlisted", "operator");
  ds.transition(p.id, "spec-drafted", "system");
  if (status === "spec-drafted") return p.id;
  ds.transition(p.id, "approved", "operator");
  ds.transition(p.id, "building", "build");
  ds.completeBuild(p.id, { previewUrl: "https://cat.me.workers.dev" });
  if (status === "launched") ds.markLaunched(p.id, MINT);
  return p.id;
}

function run(ds: Datastore, id: number, reason: string): { applied: number; errors: unknown[] } {
  ds.enqueueCommand(id, "mark-launched", reason);
  const errors: unknown[] = [];
  const applied = applyPending(ds, (_c, e) => errors.push(e));
  return { applied, errors };
}

describe("mark-launched command", () => {
  it("moves built to launched, records the mint and the history entry", () => {
    const ds = Datastore.open(":memory:");
    const id = proposalAt(ds, "built");
    expect(run(ds, id, MINT).applied).toBe(1);
    expect(ds.getProposal(id)).toMatchObject({ status: "launched", mint: MINT });
    expect(ds.historyFor(id).at(-1)).toMatchObject({ from: "built", to: "launched", actor: "operator", reason: `Operator marked launched: ${MINT}` });
    expect(ds.listCommands().at(-1)).toMatchObject({ type: "mark-launched", status: "applied" });
  });

  it("trims the mint", () => {
    const ds = Datastore.open(":memory:");
    const id = proposalAt(ds, "built");
    run(ds, id, `  ${MINT}\n`);
    expect(ds.getProposal(id)!.mint).toBe(MINT);
  });

  it("rejects a malformed mint and leaves the Proposal built", () => {
    const ds = Datastore.open(":memory:");
    const id = proposalAt(ds, "built");
    for (const bad of ["", "not-a-mint", `0${MINT.slice(1)}`, "1".repeat(45)]) run(ds, id, bad);
    expect(ds.getProposal(id)).toMatchObject({ status: "built", mint: null });
    expect(ds.listCommands().every((c) => c.status === "rejected")).toBe(true);
  });

  it("rejects any status but built", () => {
    const ds = Datastore.open(":memory:");
    const id = proposalAt(ds, "spec-drafted");
    run(ds, id, MINT);
    const p = ds.getProposal(id)!;
    expect(p.status satisfies ProposalStatus).toBe("spec-drafted");
    expect(p.mint).toBeNull();
    expect(ds.listCommands()[0]).toMatchObject({ status: "rejected" });
  });

  it("a repeat on a launched Proposal is a no-op that keeps the first mint", () => {
    const ds = Datastore.open(":memory:");
    const id = proposalAt(ds, "launched");
    run(ds, id, "9".repeat(44));
    expect(ds.getProposal(id)).toMatchObject({ status: "launched", mint: MINT });
  });
});
