import type { DatabaseSync } from "node:sqlite";
import { DomainError } from "./lifecycle.ts";

export const RUBRIC_KEYS = ["momentum", "novelty", "buildability", "hook", "legitimacy"] as const;
export type RubricKey = (typeof RUBRIC_KEYS)[number];

/** Scores run 0 to 10; a Narrative scoring below the gate on the gate dimension never becomes a Proposal. */
export const RUBRIC_MAX_SCORE = 10;
export const MAX_RUBRIC_DESCRIPTION_CHARS = 1000;
export const MAX_RUBRIC_WEIGHT = 100;

/** A Score's number for each dimension, 0 to RUBRIC_MAX_SCORE. */
export type DimensionScores = Record<RubricKey, number>;

export interface RubricDimension {
  key: RubricKey;
  description: string;
  weight: number;
}

/** One immutable version of the Rubric. A Score records the `version` it was computed with. */
export interface Rubric {
  version: number;
  dimensions: RubricDimension[];
  /** The hard gate: buildability, which must reach `gateMinScore`. */
  gateDimension: "buildability";
  gateMinScore: number;
  createdAt: string;
}

/** What the War Room editor sends: the version it loaded, the editable fields, and the gate. */
export interface RubricInput {
  baseVersion: number;
  dimensions: Array<Pick<RubricDimension, "key" | "description" | "weight">>;
  gateMinScore: number;
}

export class InvalidRubricError extends DomainError {
  constructor(message: string) {
    super(message);
    this.name = "InvalidRubricError";
  }
}

export class RubricConflictError extends DomainError {
  constructor(message = "The Rubric changed since you opened it. Reload to see the current version before saving.") {
    super(message);
    this.name = "RubricConflictError";
  }
}

const SEED: Record<RubricKey, string> = {
  momentum: "How fast the Narrative is growing across Signals right now.",
  novelty: "How fresh it is: not already a crowded or recently launched coin theme.",
  buildability: "Whether a small web app can credibly be built and deployed from it unattended (hard gate).",
  hook: "How easily the idea is explained and shared in one line.",
  legitimacy: "Whether it is free of scams, hate and real-person impersonation, and backed by real sources.",
};

const SEED_GATE_MIN_SCORE = 5;

/** Trusts nothing: checks shape, keys, lengths and ranges; returns the normalised dimensions in canonical order. */
export function validateRubricInput(input: unknown): { dimensions: RubricDimension[]; gateMinScore: number } {
  const body = input as Partial<RubricInput> | null | undefined;
  const list = body?.dimensions;
  if (!Array.isArray(list) || list.length !== RUBRIC_KEYS.length) {
    throw new InvalidRubricError(`dimensions must list exactly: ${RUBRIC_KEYS.join(", ")}`);
  }
  const byKey = new Map<string, unknown>();
  for (const d of list) byKey.set(String((d as { key?: unknown } | null)?.key), d);
  if (byKey.size !== RUBRIC_KEYS.length || RUBRIC_KEYS.some((k) => !byKey.has(k))) {
    throw new InvalidRubricError(`dimensions must list exactly: ${RUBRIC_KEYS.join(", ")}`);
  }
  const dimensions = RUBRIC_KEYS.map((key): RubricDimension => {
    const d = byKey.get(key) as { description?: unknown; weight?: unknown };
    if (typeof d.description !== "string" || !d.description.trim()) throw new InvalidRubricError(`${key}: description is required`);
    if (d.description.length > MAX_RUBRIC_DESCRIPTION_CHARS) {
      throw new InvalidRubricError(`${key}: description is over ${MAX_RUBRIC_DESCRIPTION_CHARS} characters`);
    }
    if (typeof d.weight !== "number" || !Number.isFinite(d.weight) || d.weight < 0 || d.weight > MAX_RUBRIC_WEIGHT) {
      throw new InvalidRubricError(`${key}: weight must be a number from 0 to ${MAX_RUBRIC_WEIGHT}`);
    }
    return { key, description: d.description.trim(), weight: d.weight };
  });
  if (dimensions.every((d) => d.weight === 0)) throw new InvalidRubricError("weights cannot all be zero");
  const gate = body?.gateMinScore;
  if (typeof gate !== "number" || !Number.isFinite(gate) || gate < 0 || gate > RUBRIC_MAX_SCORE) {
    throw new InvalidRubricError(`gate: buildability minimum must be a number from 0 to ${RUBRIC_MAX_SCORE}`);
  }
  return { dimensions, gateMinScore: gate };
}

export function migrateRubric(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS rubric_versions (
    version INTEGER PRIMARY KEY,
    dimensions TEXT NOT NULL,
    gate_min_score REAL NOT NULL,
    created_at TEXT NOT NULL
  )`);
  const seeded = db.prepare("SELECT 1 FROM rubric_versions LIMIT 1").get();
  if (seeded) return;
  const dimensions = RUBRIC_KEYS.map((key) => ({ key, description: SEED[key], weight: 1 }));
  db.prepare("INSERT OR IGNORE INTO rubric_versions (version, dimensions, gate_min_score, created_at) VALUES (1, ?, ?, ?)").run(
    JSON.stringify(dimensions),
    SEED_GATE_MIN_SCORE,
    new Date().toISOString(),
  );
}

export interface RubricRow {
  version: number;
  dimensions: string;
  gate_min_score: number;
  created_at: string;
}

export function toRubric(r: RubricRow): Rubric {
  return {
    version: r.version,
    dimensions: JSON.parse(r.dimensions) as RubricDimension[],
    gateDimension: "buildability",
    gateMinScore: r.gate_min_score,
    createdAt: r.created_at,
  };
}
