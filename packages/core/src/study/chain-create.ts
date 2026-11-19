import type { ParsedInstruction, ParsedTransaction } from "./helius.ts";

/**
 * Reads one parsed chain transaction and says whether it is a pump create, and which one. Pure: no network, no store.
 *
 * A create is the pump-program instruction whose `accounts[1]` is the mint-authority PDA and whose data starts with the discriminator of
 * `create` (legacy, Token program) or `create_v2` (Token-2022, quote-mint aware). The instruction is either a top-level instruction
 * (direct) or an inner one, called by a wrapper program (`CreateCoinAndBuyBondingCurveV3`, `CreateCoinAndBuyJupiterBondingCurve`).
 * Anything else that touches the PDA (`CreatePool`, a buy, a transfer) is not a create. A failed transaction is never a create.
 *
 * Argument layout and discriminators are from the pump IDL (pump-public-docs idl/pump.json, program version field 0.1.0, fetched
 * 2026-11-19; the create fragments are pinned in fixtures/pump-idl-create.json and a test compares this code with them):
 *   create    (24,30,200,40,5,28,7,119):   name string, symbol string, uri string, creator pubkey
 *   create_v2 (214,144,76,236,95,139,49,180): the same four, then is_mayhem_mode bool, is_cashback_enabled OptionBool (one bool byte),
 *             creator_fee_bps OptionU64 (eight bytes), is_holder_reward OptionBool. Older program versions sent fewer trailing
 *             arguments, so a missing trailing argument reads as false or null.
 * OptionBool and OptionU64 are one-field structs in the IDL, not tagged options: the field is the whole encoding.
 */

export const PUMP_PROGRAM = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
export const MINT_AUTHORITY_PDA = "TSLvdd1pWpHVjahSpsvCXUbgwsL3JAcvokwaKt1eokM";

export const CREATE_DISCRIMINATOR = [24, 30, 200, 40, 5, 28, 7, 119] as const;
export const CREATE_V2_DISCRIMINATOR = [214, 144, 76, 236, 95, 139, 49, 180] as const;

/** Account positions in the instruction, from the IDL: the mint, then the mint authority, and the signing user. */
export const USER_INDEX = { create: 7, create_v2: 5 } as const;

export type CreateShape = "legacy" | "v2_direct" | "v2_wrapper";

export interface ParsedCreate {
  mint: string;
  name: string;
  symbol: string;
  uri: string;
  /** The signer of the create (what PumpPortal reports as the trader). */
  user: string;
  /** The `creator` argument: the fee beneficiary, which may be a per-token address; empty on a very old create. */
  creatorArg: string;
  shape: CreateShape;
  /** The wrapper's instruction name from the logs for a wrapper-paired create, else null. */
  wrapper: string | null;
  mayhem: boolean;
  cashback: boolean;
  /** Null when the program version sent no such argument. */
  creatorFeeBps: number | null;
  holderReward: boolean | null;
  /** Bytes of arguments after `creator`: 0 for a legacy create, 1 to 11 for create_v2 depending on the program version. */
  trailingBytes: number;
  signature: string;
  /** Chain time of the block, in ISO. */
  createdAt: string;
}

export type CreateParse =
  | { kind: "create"; create: ParsedCreate }
  /** The transaction failed on chain. */
  | { kind: "failed" }
  /** A valid transaction that is not a create (a pool creation, a buy, anything else). */
  | { kind: "not_create"; reason: string }
  /** It looks like a create but cannot be read (cut-short data, no block time). */
  | { kind: "unreadable"; reason: string };

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const INDEX = new Map([...ALPHABET].map((c, i) => [c, i]));

/** Base58 to bytes; undefined for a character outside the alphabet. */
export function base58Decode(text: string): Uint8Array | undefined {
  let zeros = 0;
  while (zeros < text.length && text[zeros] === "1") zeros++;
  const bytes: number[] = [];
  for (let i = zeros; i < text.length; i++) {
    let carry = INDEX.get(text[i]!);
    if (carry === undefined) return undefined;
    for (let j = bytes.length - 1; j >= 0; j--) {
      carry += bytes[j]! * 58;
      bytes[j] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.unshift(carry & 0xff);
      carry >>= 8;
    }
  }
  return Uint8Array.from([...Array.from({ length: zeros }, () => 0), ...bytes]);
}

export function base58Encode(bytes: Uint8Array): string {
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
  const digits: number[] = [];
  for (let i = zeros; i < bytes.length; i++) {
    let carry = bytes[i]!;
    for (let j = digits.length - 1; j >= 0; j--) {
      carry += digits[j]! * 256;
      digits[j] = carry % 58;
      carry = Math.floor(carry / 58);
    }
    while (carry > 0) {
      digits.unshift(carry % 58);
      carry = Math.floor(carry / 58);
    }
  }
  return "1".repeat(zeros) + digits.map((d) => ALPHABET[d]).join("");
}

const MAX_STRING_BYTES = 1024;

class Reader {
  private pos = 0;
  private readonly bytes: Uint8Array;
  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
  }
  get left(): number {
    return this.bytes.length - this.pos;
  }
  take(n: number): Uint8Array | undefined {
    if (n < 0 || this.left < n) return undefined;
    const out = this.bytes.subarray(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }
  string(): string | undefined {
    const head = this.take(4);
    if (!head) return undefined;
    const len = new DataView(head.buffer, head.byteOffset, 4).getUint32(0, true);
    if (len > MAX_STRING_BYTES) return undefined;
    const body = this.take(len);
    return body ? new TextDecoder("utf-8", { fatal: false }).decode(body) : undefined;
  }
}

const startsWith = (bytes: Uint8Array, disc: readonly number[]): boolean => bytes.length >= 8 && disc.every((b, i) => bytes[i] === b);

interface Found {
  ix: ParsedInstruction;
  data: Uint8Array;
  version: "create" | "create_v2";
  /** The top-level program that holds the instruction: the pump program itself for a direct create. */
  topProgram: string;
}

function isCreateInstruction(ix: ParsedInstruction): { data: Uint8Array; version: "create" | "create_v2" } | undefined {
  if (ix.programId !== PUMP_PROGRAM || !ix.accounts || ix.accounts[1] !== MINT_AUTHORITY_PDA || typeof ix.data !== "string") return undefined;
  const data = base58Decode(ix.data);
  if (!data) return undefined;
  if (startsWith(data, CREATE_V2_DISCRIMINATOR)) return { data, version: "create_v2" };
  if (startsWith(data, CREATE_DISCRIMINATOR)) return { data, version: "create" };
  return undefined;
}

function findCreate(tx: ParsedTransaction): Found | undefined {
  const top = tx.transaction.message.instructions;
  for (const ix of top) {
    const hit = isCreateInstruction(ix);
    if (hit) return { ix, ...hit, topProgram: ix.programId };
  }
  for (const group of tx.meta?.innerInstructions ?? []) {
    for (const ix of group.instructions) {
      const hit = isCreateInstruction(ix);
      if (hit) return { ix, ...hit, topProgram: top[group.index]?.programId ?? "" };
    }
  }
  return undefined;
}

const WRAPPER_LOG = /Instruction: (CreateCoinAndBuy\w+)/;

/** Whether the transaction is a create and, if so, its fields. `signature` is taken from the transaction itself. */
export function parseCreateTransaction(tx: ParsedTransaction): CreateParse {
  if (!tx.meta) return { kind: "unreadable", reason: "the transaction has no meta" };
  if (tx.meta.err !== null && tx.meta.err !== undefined) return { kind: "failed" };
  const found = findCreate(tx);
  if (!found) return { kind: "not_create", reason: "no create instruction on the mint-authority account" };
  if (tx.blockTime === null || tx.blockTime === undefined || !Number.isFinite(tx.blockTime)) return { kind: "unreadable", reason: "the transaction has no block time" };

  const accounts = found.ix.accounts!;
  const mint = accounts[0];
  const user = accounts[USER_INDEX[found.version]] ?? "";
  const signature = tx.transaction.signatures[0];
  if (!mint || !signature) return { kind: "unreadable", reason: "the create has no mint or no signature" };

  const r = new Reader(found.data.subarray(8));
  const name = r.string();
  const symbol = r.string();
  const uri = r.string();
  if (name === undefined || symbol === undefined || uri === undefined) return { kind: "unreadable", reason: "the create arguments are cut short" };
  const creatorBytes = r.take(32);
  const creatorArg = creatorBytes ? base58Encode(creatorBytes) : "";

  let mayhem = false;
  let cashback = false;
  let creatorFeeBps: number | null = null;
  let holderReward: boolean | null = null;
  const trailingBytes = r.left;
  if (found.version === "create_v2") {
    // Program versions sent 0, 1, 2, 10 or 11 trailing bytes (and, in 2026-11, one 3-byte form the pinned IDL does not describe). Only the
    // two leading flags and, for the two forms the IDL does describe, the fee and the holder flag are read; a layout it does not describe
    // leaves them null rather than guessing.
    const m = r.take(1);
    if (m) mayhem = m[0] === 1;
    const c = r.take(1);
    if (c) cashback = c[0] === 1;
    if (trailingBytes === 10 || trailingBytes === 11) {
      const fee = r.take(8)!;
      creatorFeeBps = Number(new DataView(fee.buffer, fee.byteOffset, 8).getBigUint64(0, true));
    }
    if (trailingBytes === 11) holderReward = r.take(1)![0] === 1;
  }

  const wrapper = found.topProgram === PUMP_PROGRAM ? null : (tx.meta.logMessages ?? []).map((l) => WRAPPER_LOG.exec(l)?.[1]).find((n) => n !== undefined) ?? "unknown wrapper";
  const shape: CreateShape = found.version === "create" ? "legacy" : found.topProgram === PUMP_PROGRAM ? "v2_direct" : "v2_wrapper";
  return {
    kind: "create",
    create: { mint, name, symbol, uri, user, creatorArg, shape, wrapper, mayhem, cashback, creatorFeeBps, holderReward, trailingBytes, signature, createdAt: new Date(tx.blockTime * 1000).toISOString() },
  };
}
