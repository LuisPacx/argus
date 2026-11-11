import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Datastore, migrate } from "./datastore.ts";
import { tempDir } from "./testing/temp.ts";
import { InvalidRubricError, MAX_RUBRIC_DESCRIPTION_CHARS, RubricConflictError, TECH_VALUE_LINE, type RubricInput } from "./rubric.ts";

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

  describe("the Tech-value line (ticket 17)", () => {
    const OLD_HOOK = "How easily the idea is explained and shared in one line.";
    /** A database as the live one is: Rubric version 1 seeded before the Tech-value line existed, with its own weights and gate. */
    const oldDb = (version1Hook = OLD_HOOK, more?: (db: DatabaseSync) => void): string => {
      const path = join(tempDir("argus-rubric-"), "argus.db");
      const db = new DatabaseSync(path);
      db.exec("CREATE TABLE rubric_versions (version INTEGER PRIMARY KEY, dimensions TEXT NOT NULL, gate_min_score REAL NOT NULL, created_at TEXT NOT NULL)");
      const dims = ["momentum", "novelty", "buildability", "hook", "legitimacy"].map((key, i) => ({ key, description: key === "hook" ? version1Hook : `${key} text`, weight: i + 1 }));
      db.prepare("INSERT INTO rubric_versions VALUES (1, ?, 6, '2026-06-01T00:00:00.000Z')").run(JSON.stringify(dims));
      more?.(db);
      db.close();
      return path;
    };

    it("a fresh database seeds the line in version 1", () => {
      const r = Datastore.open(":memory:").getRubric();
      expect(r.version).toBe(1);
      expect(r.dimensions.find((d) => d.key === "hook")!.description).toContain(TECH_VALUE_LINE);
    });

    it("an existing database gets one new version: the line appended to hook, everything else and version 1 untouched", () => {
      const ds = Datastore.open(oldDb());
      expect(ds.listRubricVersions()).toEqual([2, 1]);
      const v1 = ds.getRubric(1);
      const v2 = ds.getRubric(2);
      expect(v1.dimensions.find((d) => d.key === "hook")!.description).toBe(OLD_HOOK);
      expect(v2.dimensions.find((d) => d.key === "hook")!.description).toBe(`${OLD_HOOK} ${TECH_VALUE_LINE}`);
      expect(v2.dimensions.filter((d) => d.key !== "hook")).toEqual(v1.dimensions.filter((d) => d.key !== "hook"));
      expect(v2.dimensions.map((d) => d.weight)).toEqual([1, 2, 3, 4, 5]);
      expect(v2.gateMinScore).toBe(6);
      expect(ds.getRubric().version).toBe(2);
    });

    it("runs once: a second migration, or an Operator who later removes the line, adds nothing", () => {
      const path = oldDb();
      Datastore.open(path).close();
      const ds = Datastore.open(path);
      expect(ds.listRubricVersions()).toEqual([2, 1]);
      const cur = ds.getRubric();
      ds.saveRubric({ baseVersion: 2, dimensions: cur.dimensions.map((d) => ({ key: d.key, weight: d.weight, description: d.key === "hook" ? OLD_HOOK : d.description })), gateMinScore: cur.gateMinScore });
      ds.close();
      const again = Datastore.open(path);
      expect(again.listRubricVersions()).toEqual([3, 2, 1]);
      again.close();
    });

    it("builds on the Operator's latest version, not on version 1", () => {
      const path = oldDb(OLD_HOOK, (db) =>
        db.prepare("INSERT INTO rubric_versions VALUES (2, ?, 7, '2026-06-02T00:00:00.000Z')").run(
          JSON.stringify(["momentum", "novelty", "buildability", "hook", "legitimacy"].map((key) => ({ key, description: `${key} edited`, weight: 1 }))),
        ),
      );
      const v3 = Datastore.open(path).getRubric();
      expect(v3.version).toBe(3);
      expect(v3.gateMinScore).toBe(7);
      expect(v3.dimensions.find((d) => d.key === "hook")!.description).toBe(`hook edited ${TECH_VALUE_LINE}`);
      expect(v3.dimensions.find((d) => d.key === "momentum")!.description).toBe("momentum edited");
    });

    it("keeps the new description inside the Rubric editor's length limit", () => {
      const hook = Datastore.open(oldDb("h".repeat(MAX_RUBRIC_DESCRIPTION_CHARS))).getRubric().dimensions.find((d) => d.key === "hook")!.description;
      expect(hook.length).toBeLessThanOrEqual(MAX_RUBRIC_DESCRIPTION_CHARS);
      expect(hook.endsWith(TECH_VALUE_LINE)).toBe(true);
    });
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
