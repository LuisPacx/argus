import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { Datastore, migrate } from "./datastore.ts";
import { InvalidRubricError, RubricConflictError, type RubricInput } from "./rubric.ts";

const edit = (over: Partial<RubricInput> = {}): RubricInput => {
  const r = Datastore.open(":memory:").getRubric();
  return { baseVersion: r.version, dimensions: r.dimensions.map(({ key, description, weight }) => ({ key, description, weight })), gateMinScore: r.gateMinScore, ...over };
};

describe("Rubric storage", () => {
  it("is seeded at version 1 with the five dimensions at equal weights and buildability as the gate", () => {
    const r = Datastore.open(":memory:").getRubric();
    expect(r.version).toBe(1);
    expect(r.dimensions.map((d) => d.key)).toEqual(["momentum", "novelty", "buildability", "hook", "legitimacy"]);
    expect(new Set(r.dimensions.map((d) => d.weight)).size).toBe(1);
    expect(r.dimensions.every((d) => d.description.length > 0)).toBe(true);
    expect(r.gateDimension).toBe("buildability");
    expect(r.gateMinScore).toBeGreaterThan(0);
  });

  it("seeds once: re-running the migration keeps edits", () => {
    const db = new DatabaseSync(":memory:");
    migrate(db);
    migrate(db);
    expect(db.prepare("SELECT COUNT(*) AS n FROM rubric_versions").get()).toEqual({ n: 1 });
  });

  it("saves descriptions, weights and the gate as a new version and keeps the old one", () => {
    const ds = Datastore.open(":memory:");
    const base = ds.getRubric();
    const dims = base.dimensions.map(({ key, description, weight }) => ({ key, description, weight }));
    dims[0] = { key: "momentum", description: "How fast it is spreading", weight: 3 };
    const saved = ds.saveRubric({ baseVersion: 1, dimensions: dims, gateMinScore: 7 });
    expect(saved.version).toBe(2);
    expect(ds.getRubric()).toMatchObject({ version: 2, gateMinScore: 7 });
    expect(ds.getRubric().dimensions[0]).toMatchObject({ description: "How fast it is spreading", weight: 3 });
    expect(ds.getRubric(1)).toEqual(base);
    expect(ds.listRubricVersions()).toEqual([2, 1]);
  });

  it("does not create a version for an unchanged save", () => {
    const ds = Datastore.open(":memory:");
    expect(ds.saveRubric(edit()).version).toBe(1);
  });

  it("refuses a save made from a stale version", () => {
    const ds = Datastore.open(":memory:");
    ds.saveRubric(edit({ gateMinScore: 6 }));
    expect(() => ds.saveRubric(edit({ baseVersion: 1, gateMinScore: 8 }))).toThrow(RubricConflictError);
  });

  const bad: Array<[string, Partial<RubricInput>, RegExp]> = [
    ["a blank description", { dimensions: edit().dimensions.map((d, i) => (i === 1 ? { ...d, description: "  " } : d)) }, /novelty.*description/i],
    ["a negative weight", { dimensions: edit().dimensions.map((d, i) => (i === 0 ? { ...d, weight: -1 } : d)) }, /momentum.*weight/i],
    ["a non-numeric weight", { dimensions: edit().dimensions.map((d, i) => (i === 0 ? { ...d, weight: Number.NaN } : d)) }, /momentum.*weight/i],
    ["all-zero weights", { dimensions: edit().dimensions.map((d) => ({ ...d, weight: 0 })) }, /weight/i],
    ["a missing dimension", { dimensions: edit().dimensions.slice(1) }, /dimensions/i],
    ["an unknown dimension", { dimensions: edit().dimensions.map((d, i) => (i === 0 ? { ...d, key: "vibes" as never } : d)) }, /dimensions/i],
    ["a gate over 10", { gateMinScore: 11 }, /gate/i],
    ["a non-numeric gate", { gateMinScore: "high" as unknown as number }, /gate/i],
  ];
  for (const [name, over, msg] of bad) {
    it(`refuses ${name} with a message and stores nothing`, () => {
      const ds = Datastore.open(":memory:");
      expect(() => ds.saveRubric({ ...edit(), ...over })).toThrow(InvalidRubricError);
      expect(() => ds.saveRubric({ ...edit(), ...over })).toThrow(msg);
      expect(ds.getRubric().version).toBe(1);
    });
  }
});
