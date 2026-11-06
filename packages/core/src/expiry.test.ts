import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Datastore } from "./datastore.ts";
import { expireStaleProposals } from "./expiry.ts";
import { tempDir } from "./testing/temp.ts";

const HOUR = 3_600_000;
const input = {
  narrativeSummary: "n",
  techOneLiner: "t",
  whyNow: "w",
  name: "Cat Coin",
  ticker: "CAT",
  description: "d",
  evidenceLinks: [],
};

/** A fake clock: `at(h)` is `h` hours after the Proposal's last change. */
const after = (iso: string, hours: number) => new Date(new Date(iso).getTime() + hours * HOUR);

describe("expiry (architecture section 3)", () => {
  it("closes a new Proposal after 48 hours as the system with reason stale, and not before", () => {
    const ds = Datastore.open(":memory:");
    const p = ds.createProposal(input);
    expect(expireStaleProposals(ds, after(p.updatedAt, 47.9))).toBe(0);
    expect(ds.getProposal(p.id)!.status).toBe("new");
    expect(expireStaleProposals(ds, after(p.updatedAt, 48))).toBe(1);
    expect(ds.getProposal(p.id)!.status).toBe("closed");
    expect(ds.historyFor(p.id).at(-1)).toMatchObject({ from: "new", to: "closed", actor: "system", reason: "stale" });
  });

  it("closes a shortlisted Proposal after 7 days counted from the shortlisting", () => {
    const ds = Datastore.open(":memory:");
    const p = ds.createProposal(input);
    ds.transition(p.id, "shortlisted", "operator");
    const since = ds.getProposal(p.id)!.updatedAt;
    expect(expireStaleProposals(ds, after(since, 167))).toBe(0);
    expect(expireStaleProposals(ds, after(since, 168))).toBe(1);
    expect(ds.getProposal(p.id)!.status).toBe("closed");
  });

  it("never expires spec-drafted or any other state", () => {
    const ds = Datastore.open(":memory:");
    const p = ds.createProposal(input);
    ds.transition(p.id, "shortlisted", "operator");
    ds.transition(p.id, "spec-drafted", "system");
    const since = ds.getProposal(p.id)!.updatedAt;
    expect(expireStaleProposals(ds, after(since, 24 * 365))).toBe(0);
    expect(ds.getProposal(p.id)!.status).toBe("spec-drafted");
  });

  it("never expires a Proposal with a Brain run in flight, then expires it once the run ends", () => {
    const ds = Datastore.open(":memory:");
    const p = ds.createProposal(input);
    ds.transition(p.id, "shortlisted", "operator");
    const since = ds.getProposal(p.id)!.updatedAt;
    const runId = ds.startBrainRun({ proposalId: p.id, task: "spec", backend: "claude-code", model: "m" });
    expect(expireStaleProposals(ds, after(since, 24 * 30))).toBe(0);
    expect(ds.getProposal(p.id)!.status).toBe("shortlisted");
    ds.finishBrainRun(runId, { sessionId: null, totalCostUsd: 0, exitStatus: "error" });
    expect(expireStaleProposals(ds, after(since, 24 * 30))).toBe(1);
    expect(ds.getProposal(p.id)!.status).toBe("closed");
  });

  it("counts from the latest transition into the current status: a later write (a Spec edit) does not extend a Proposal's life", () => {
    const file = join(tempDir("argus-expiry-"), "argus.db");
    const ds = Datastore.open(file);
    const p = ds.createProposal(input);
    ds.transition(p.id, "shortlisted", "operator");
    const before = ds.getProposal(p.id)!;
    // Any later write moves proposals.updated_at (the Spec save does); do the same from outside, a day on.
    const later = after(before.updatedAt, 24).toISOString();
    const raw = new DatabaseSync(file);
    raw.prepare("UPDATE proposals SET updated_at = ? WHERE id = ?").run(later, p.id);
    raw.close();
    const edited = ds.getProposal(p.id)!;
    expect(edited.updatedAt).toBe(later);
    expect(edited.expiresAt).toBe(before.expiresAt);
    expect(expireStaleProposals(ds, after(before.updatedAt, 168))).toBe(1);
  });

  it("exposes when each Proposal expires so the card can show the time left", () => {
    const ds = Datastore.open(":memory:");
    const p = ds.createProposal(input);
    expect(ds.getProposal(p.id)!.expiresAt).toBe(new Date(new Date(p.updatedAt).getTime() + 48 * HOUR).toISOString());
    ds.transition(p.id, "shortlisted", "operator");
    const s = ds.getProposal(p.id)!;
    expect(s.expiresAt).toBe(new Date(new Date(s.updatedAt).getTime() + 168 * HOUR).toISOString());
    ds.transition(p.id, "spec-drafted", "system");
    expect(ds.getProposal(p.id)!.expiresAt).toBeNull();
  });
});
