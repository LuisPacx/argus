import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Phase 3 ticket 01: the recorded PumpPortal and Helius fixtures are real, parse, carry the fields the later tickets need,
 * and hold no secret. Tickets 02, 03, 04 and 10 test against them offline.
 */

const DIR = dirname(fileURLToPath(import.meta.url));
const names = (prefix: string) => readdirSync(DIR).filter((f) => f.startsWith(prefix) && f.endsWith(".json")).sort();
const read = (f: string): unknown => JSON.parse(readFileSync(join(DIR, f), "utf8"));
const MINT = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

describe("phase 3 fixtures", () => {
  it("has PumpPortal and Helius fixture files", () => {
    expect(names("pumpportal-").length).toBeGreaterThanOrEqual(2);
    expect(names("helius-").length).toBeGreaterThanOrEqual(2);
  });

  it("holds no api key or api-key= query value", () => {
    const key = process.env.HELIUS_API_KEY;
    for (const f of [...names("pumpportal-"), ...names("helius-")]) {
      const text = readFileSync(join(DIR, f), "utf8");
      expect(text, f).not.toMatch(/api-key=/i);
      if (key) expect(text.includes(key), f).toBe(false);
    }
    for (const f of names("helius-")) {
      expect(readFileSync(join(DIR, f), "utf8"), f).not.toMatch(UUID);
    }
  });

  it("pumpportal create event has txType create, a mint, a name and a symbol", () => {
    const create = read("pumpportal-create.json") as Record<string, unknown>;
    expect(create.txType).toBe("create");
    expect(String(create.mint)).toMatch(MINT);
    expect(typeof create.name).toBe("string");
    expect(typeof create.symbol).toBe("string");
  });

  it("pumpportal migrate event carries a mint", () => {
    const migrate = read("pumpportal-migrate.json") as Record<string, unknown>;
    expect(migrate.txType).toBe("migrate");
    expect(String(migrate.mint)).toMatch(MINT);
  });

  it("helius create transaction response lists a transaction with a block time and logs", () => {
    const r = read("helius-create-transaction.json") as { result: { data: { blockTime: number; meta: { logMessages: string[] } }[] } };
    const tx = r.result.data[0];
    expect(typeof tx?.blockTime).toBe("number");
    expect(tx?.meta.logMessages.some((l) => l.includes("Instruction: CreateV2"))).toBe(true);
  });

  it("helius curve response includes a migrate transaction", () => {
    const r = read("helius-curve-transactions.json") as { result: { data: { blockTime: number; meta: { logMessages: string[] } }[] } };
    expect(r.result.data.some((t) => t.meta.logMessages.some((l) => l.includes("Instruction: Migrate")))).toBe(true);
  });
});
