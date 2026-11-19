import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { fakeCreateTx, fakeNotCreateTx } from "../testing/fake-chain.ts";
import {
  CREATE_DISCRIMINATOR,
  CREATE_V2_DISCRIMINATOR,
  MINT_AUTHORITY_PDA,
  PUMP_PROGRAM,
  USER_INDEX,
  base58Decode,
  base58Encode,
  parseCreateTransaction,
} from "./chain-create.ts";
import type { ParsedTransaction } from "./helius.ts";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures");
const rpcResult = (file: string): ParsedTransaction => (JSON.parse(readFileSync(join(FIXTURES, file), "utf8")) as { result: ParsedTransaction }).result;
const create = (file: string) => {
  const p = parseCreateTransaction(rpcResult(file));
  if (p.kind !== "create") throw new Error(`${file} did not parse as a create: ${JSON.stringify(p)}`);
  return p.create;
};

describe("create parsing on recorded mainnet transactions (fixtures/helius-create-*.json)", () => {
  it("reads a legacy create (Token program, no flags)", () => {
    expect(create("helius-create-legacy.json")).toMatchObject({
      mint: "As2CbA6unmFucP6KoXDT4NijFvnNzJSTBwBcrBXnpump",
      name: "SELEN AI",
      symbol: "SELEN",
      uri: expect.stringMatching(/^https:\/\/ipfs\.io\/ipfs\/Qm/) as string,
      user: "7jRQrwrB9JRKxm2VUx1WdmNq6dPhPW6DXJ7wcoYnLrTr",
      shape: "legacy",
      wrapper: null,
      mayhem: false,
      cashback: false,
      creatorFeeBps: null,
      holderReward: null,
      trailingBytes: 0,
      createdAt: "2025-05-01T00:00:01.000Z",
    });
  });

  it("reads a create_v2 sent directly by the creator, with the creator's fee and the holder flag as the IDL lays them out", () => {
    expect(create("helius-create-v2-direct.json")).toMatchObject({
      mint: "8Ywww6BrkimYH2KwSTMo4UAA2wGQ12j9nAh4ZZ7KgQMt",
      name: "ShiboCoin",
      symbol: "SHIBO",
      shape: "v2_direct",
      wrapper: null,
      mayhem: false,
      cashback: false,
      creatorFeeBps: 0,
      holderReward: false,
      trailingBytes: 11,
      createdAt: "2026-11-19T16:13:44.000Z",
    });
    expect(create("helius-create-v2-holder-reward.json")).toMatchObject({ shape: "v2_direct", holderReward: true, creatorFeeBps: 30, mayhem: false, cashback: false });
  });

  it("reads the mayhem flag (is_mayhem_mode, the first argument after creator)", () => {
    expect(create("helius-create-v2-mayhem.json")).toMatchObject({ mint: "3E4FuVCwT2CeyyGStjHecrMoTyUXLvD2znwMBQibpump", shape: "v2_direct", mayhem: true, cashback: false });
  });

  it("reads the cashback flag (is_cashback_enabled, the second argument): the transaction is a real create_v2 with that one byte set, as no real one was found", () => {
    // 3,000 recent creates held no cashback-enabled one; the fixture is the direct create above with byte 2 of the flags set (see its name).
    expect(create("helius-create-v2-cashback-derived.json")).toMatchObject({ mint: "8Ywww6BrkimYH2KwSTMo4UAA2wGQ12j9nAh4ZZ7KgQMt", mayhem: false, cashback: true });
  });

  it("reads wrapper-paired creates (the pump create is an inner instruction) and names the wrapper", () => {
    expect(create("helius-create-v2-wrapper-v3.json")).toMatchObject({
      mint: "7NDqGEaiTiqpuCxJGXTfNaTh645vXFR9oSC2XYQXpump",
      shape: "v2_wrapper",
      wrapper: "CreateCoinAndBuyBondingCurveV3",
      user: "GWZKDduvUzsPLuV6CtScezby37f4VKK5uRh6UJZjh5Xr",
    });
    expect(create("helius-create-v2-wrapper-jupiter.json")).toMatchObject({
      mint: "2aGt7sKkJDpgXEMxgXpuW7KRYkB7P7pbVuMAw24dpump",
      shape: "v2_wrapper",
      wrapper: "CreateCoinAndBuyJupiterBondingCurve",
    });
  });

  it("drops a failed transaction", () => {
    const failed = rpcResult("helius-tx-failed.json");
    expect(failed.meta?.err).not.toBeNull();
    expect(parseCreateTransaction(failed)).toEqual({ kind: "failed" });
  });

  it("skips a transaction on the mint-authority address that is not a create (a pool creation)", () => {
    const tx = rpcResult("helius-tx-not-create.json");
    expect(tx.meta?.logMessages?.some((l) => l.includes("Instruction: CreatePool"))).toBe(true);
    expect(parseCreateTransaction(tx)).toMatchObject({ kind: "not_create" });
  });
});

describe("create parsing is pinned to the pump IDL (fixtures/pump-idl-create.json)", () => {
  const idl = JSON.parse(readFileSync(join(FIXTURES, "pump-idl-create.json"), "utf8")) as {
    address: string;
    instructions: Array<{ name: string; discriminator: number[]; accounts: string[]; args: Array<{ name: string; type: unknown }> }>;
    types: Array<{ name: string; type: { kind: string; fields: unknown[] } }>;
  };
  const ix = (name: string) => idl.instructions.find((i) => i.name === name)!;

  it("uses the IDL's program, discriminators and account positions", () => {
    expect(idl.address).toBe(PUMP_PROGRAM);
    expect(ix("create").discriminator).toEqual([...CREATE_DISCRIMINATOR]);
    expect(ix("create_v2").discriminator).toEqual([...CREATE_V2_DISCRIMINATOR]);
    for (const name of ["create", "create_v2"] as const) {
      expect(ix(name).accounts[0]).toBe("mint");
      expect(ix(name).accounts[1]).toBe("mint_authority");
      expect(ix(name).accounts.indexOf("user")).toBe(USER_INDEX[name]);
    }
  });

  it("reads the flags in the IDL's argument order: mayhem, cashback, fee, holder reward; the Option types are one-field structs, not tagged options", () => {
    expect(ix("create").args.map((a) => a.name)).toEqual(["name", "symbol", "uri", "creator"]);
    expect(ix("create_v2").args.map((a) => a.name)).toEqual(["name", "symbol", "uri", "creator", "is_mayhem_mode", "is_cashback_enabled", "creator_fee_bps", "is_holder_reward"]);
    const type = (name: string) => idl.types.find((t) => t.name === name)!.type;
    expect(type("OptionBool")).toEqual({ kind: "struct", fields: ["bool"] }); // one byte
    expect(type("OptionU64")).toEqual({ kind: "struct", fields: ["u64"] }); // eight bytes
    // the create_v2 tail is therefore 1 + 1 + 8 + 1 = 11 bytes, as the recorded transactions have
    expect(create("helius-create-v2-direct.json").trailingBytes).toBe(11);
    expect(MINT_AUTHORITY_PDA).toBe("TSLvdd1pWpHVjahSpsvCXUbgwsL3JAcvokwaKt1eokM");
  });
});

describe("create parsing on constructed transactions", () => {
  it("reads older create_v2 argument forms (2 and 10 trailing bytes) and does not guess at an undescribed 3-byte form", () => {
    const base = { n: 1, blockTime: 1_700_000_000 };
    const two = parseCreateTransaction(fakeCreateTx({ ...base, tail: [1, 0] }));
    expect(two).toMatchObject({ kind: "create", create: { mayhem: true, cashback: false, creatorFeeBps: null, holderReward: null, trailingBytes: 2 } });
    const ten = parseCreateTransaction(fakeCreateTx({ ...base, tail: [0, 1, 44, 1, 0, 0, 0, 0, 0, 0] }));
    expect(ten).toMatchObject({ kind: "create", create: { mayhem: false, cashback: true, creatorFeeBps: 300, holderReward: null, trailingBytes: 10 } });
    const three = parseCreateTransaction(fakeCreateTx({ ...base, tail: [0, 0, 1] }));
    expect(three).toMatchObject({ kind: "create", create: { holderReward: null, creatorFeeBps: null, trailingBytes: 3 } });
    expect(parseCreateTransaction(fakeCreateTx({ ...base, tail: [] }))).toMatchObject({ kind: "create", create: { mayhem: false, cashback: false, trailingBytes: 0 } });
  });

  it("is a create only when the mint-authority account is accounts[1] of a pump create instruction", () => {
    const tx = fakeCreateTx({ n: 2, blockTime: 1_700_000_000 });
    const ix = tx.transaction.message.instructions[0]!;
    ix.accounts![1] = "Other".padEnd(44, "o");
    expect(parseCreateTransaction(tx)).toMatchObject({ kind: "not_create" });
    const other = fakeCreateTx({ n: 3, blockTime: 1_700_000_000 });
    other.transaction.message.instructions[0]!.programId = "Else".padEnd(44, "e");
    expect(parseCreateTransaction(other)).toMatchObject({ kind: "not_create" });
    expect(parseCreateTransaction(fakeNotCreateTx(4, 1_700_000_000))).toMatchObject({ kind: "not_create" });
  });

  it("says unreadable, never a create, for cut-short data, a missing block time or no meta", () => {
    const cut = fakeCreateTx({ n: 5, blockTime: 1_700_000_000 });
    const ix = cut.transaction.message.instructions[0]!;
    ix.data = base58Encode(base58Decode(ix.data!)!.subarray(0, 14));
    expect(parseCreateTransaction(cut)).toMatchObject({ kind: "unreadable" });
    expect(parseCreateTransaction({ ...fakeCreateTx({ n: 6, blockTime: 1 }), blockTime: null })).toMatchObject({ kind: "unreadable" });
    expect(parseCreateTransaction({ ...fakeCreateTx({ n: 7, blockTime: 1 }), meta: null })).toMatchObject({ kind: "unreadable" });
  });
});

describe("base58", () => {
  it("round-trips, including leading zero bytes", () => {
    for (const bytes of [[], [0], [0, 0, 1, 2, 3], [255, 254, 253], Array.from({ length: 32 }, (_, i) => i * 7)]) {
      const u = Uint8Array.from(bytes);
      expect([...base58Decode(base58Encode(u))!]).toEqual(bytes);
    }
    expect(base58Decode("0OIl")).toBeUndefined();
  });
});
