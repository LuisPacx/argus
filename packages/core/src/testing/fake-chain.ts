import { CREATE_DISCRIMINATOR, CREATE_V2_DISCRIMINATOR, MINT_AUTHORITY_PDA, PUMP_PROGRAM, base58Encode } from "../study/chain-create.ts";
import { PINNED_ENDPOINT, SIGNATURES_VERB, TXS_FOR_ADDRESS_VERB, TX_VERB, type ParsedTransaction, type SignatureInfo } from "../study/helius.ts";

/**
 * A fake chain for tests of the chain-sourced creates job: transaction builders and a `fetch` that answers the three read verbs from
 * memory, counts the calls, and can be told to fail. Nothing here touches a network. The answers carry no protocol envelope field the
 * wrappers do not read.
 */

export const TEST_KEY = "test-key-not-a-real-key";
const WRAPPER_PROGRAM = "Wrap".padEnd(44, "p");

export const fakeMint = (n: number): string => `Mint${n}`.padEnd(40, "x") + "pump";
export const fakeSignature = (n: number): string => `Sig${n}`.padEnd(88, "z");
export const fakeUser = (n: number): string => `User${n}`.padEnd(44, "1");

export interface FakeCreateSpec {
  n: number;
  /** Unix seconds. */
  blockTime: number;
  version?: "legacy" | "v2";
  /** A wrapper program calls the pump create (an inner instruction). */
  wrapper?: "CreateCoinAndBuyBondingCurveV3" | "CreateCoinAndBuyJupiterBondingCurve";
  name?: string;
  symbol?: string;
  uri?: string;
  mayhem?: boolean;
  cashback?: boolean;
  /** The transaction failed on chain. */
  failed?: boolean;
  /** The bytes after `creator` in a create_v2, instead of the full eleven-byte form. */
  tail?: number[];
}

const u32 = (n: number): number[] => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff];
const str = (s: string): number[] => {
  const b = [...new TextEncoder().encode(s)];
  return [...u32(b.length), ...b];
};

/** A parsed create transaction in the shape a single-transaction read returns it. */
export function fakeCreateTx(spec: FakeCreateSpec): ParsedTransaction {
  const v2 = (spec.version ?? "v2") === "v2";
  const data = [
    ...(v2 ? CREATE_V2_DISCRIMINATOR : CREATE_DISCRIMINATOR),
    ...str(spec.name ?? `Token ${spec.n}`),
    ...str(spec.symbol ?? `T${spec.n}`),
    ...str(spec.uri ?? `https://ipfs.io/ipfs/meta${spec.n}`),
    ...Array.from({ length: 32 }, () => 7),
    ...(v2 ? (spec.tail ?? [spec.mayhem ? 1 : 0, spec.cashback ? 1 : 0, ...Array.from({ length: 8 }, () => 0), 0]) : []),
  ];
  const accounts = Array.from({ length: v2 ? 16 : 14 }, () => "Filler".padEnd(44, "f"));
  accounts[0] = fakeMint(spec.n);
  accounts[1] = MINT_AUTHORITY_PDA;
  accounts[v2 ? 5 : 7] = fakeUser(spec.n);
  const create = { programId: PUMP_PROGRAM, accounts, data: base58Encode(Uint8Array.from(data)) };
  const logs = ["Program log: Instruction: CreateV2"];
  const message = spec.wrapper ? { accountKeys: [], instructions: [{ programId: WRAPPER_PROGRAM, accounts: [], data: "" }] } : { accountKeys: [], instructions: [create] };
  if (spec.wrapper) logs.unshift(`Program log: Instruction: ${spec.wrapper}`);
  return {
    slot: 1000 + spec.n,
    blockTime: spec.blockTime,
    transaction: { signatures: [fakeSignature(spec.n)], message },
    meta: { err: spec.failed ? { InstructionError: [0, { Custom: 1 }] } : null, logMessages: logs, innerInstructions: spec.wrapper ? [{ index: 0, instructions: [create] }] : [] },
  };
}

/** A successful transaction on the mint-authority address that is not a create (a pool creation). */
export function fakeNotCreateTx(n: number, blockTime: number): ParsedTransaction {
  return {
    slot: 5000 + n,
    blockTime,
    transaction: { signatures: [fakeSignature(n)], message: { accountKeys: [], instructions: [{ programId: PUMP_PROGRAM, accounts: ["A".padEnd(44, "a"), MINT_AUTHORITY_PDA], data: base58Encode(Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8])) }] } },
    meta: { err: null, logMessages: ["Program log: Instruction: CreatePool"], innerInstructions: [] },
  };
}

export type FakeFailure = "rate_limit" | "server_error" | "rpc_error" | "auth" | "not_json";

export interface FakeCall {
  verb: string;
  address: string;
  params: Record<string, unknown>;
}

/** The fake node: the address's signatures (newest first), every transaction by signature, and each mint's earliest transaction. */
export class FakeChain {
  /** The mint-authority address's entries, newest first (blockTime descending). */
  signatures: SignatureInfo[] = [];
  readonly txBySignature = new Map<string, ParsedTransaction>();
  readonly earliestByMint = new Map<string, ParsedTransaction | null>();
  readonly calls: FakeCall[] = [];
  /** Called before each call with the 1-based call number; return a failure to answer with it instead. */
  failure: ((callNumber: number, call: FakeCall) => FakeFailure | undefined) | undefined;

  /** Adds a create (or other transaction) as the next signature of the address; add in newest-first order. */
  addToAddress(tx: ParsedTransaction, ok = true): void {
    const signature = tx.transaction.signatures[0]!;
    this.signatures.push({ signature, slot: tx.slot, err: ok && tx.meta?.err === null ? null : (tx.meta?.err ?? { failed: true }), blockTime: tx.blockTime });
    this.txBySignature.set(signature, tx);
  }

  count(verb: string): number {
    return this.calls.filter((c) => c.verb === verb).length;
  }

  readonly fetch: typeof fetch = async (input, init) => {
    const url = String(input);
    if (!url.startsWith(PINNED_ENDPOINT) || !url.includes(`api-key=${TEST_KEY}`)) return new Response("wrong endpoint", { status: 404 });
    const body = JSON.parse(String(init?.body)) as { method: string; params: unknown[] };
    const call: FakeCall = { verb: body.method, address: String(body.params[0]), params: (body.params[1] ?? {}) as Record<string, unknown> };
    this.calls.push(call);
    const fail = this.failure?.(this.calls.length, call);
    if (fail === "rate_limit") return new Response("slow down", { status: 429 });
    if (fail === "server_error") return new Response("boom", { status: 503 });
    if (fail === "auth") return new Response("no", { status: 401 });
    if (fail === "not_json") return new Response("<html>", { status: 200 });
    if (fail === "rpc_error") return Response.json({ id: 1, error: { code: -32000, message: "something odd" } });
    return Response.json({ id: 1, result: this.answer(call) });
  };

  private answer(call: FakeCall): unknown {
    if (call.verb === SIGNATURES_VERB) {
      const before = call.params.before as string | undefined;
      const limit = (call.params.limit as number | undefined) ?? 1000;
      const start = before ? this.signatures.findIndex((s) => s.signature === before) + 1 : 0;
      return this.signatures.slice(start, start + limit);
    }
    if (call.verb === TX_VERB) return this.txBySignature.get(call.address) ?? null;
    if (call.verb === TXS_FOR_ADDRESS_VERB) {
      const tx = this.earliestByMint.get(call.address);
      return { data: tx ? [tx] : [], paginationToken: null };
    }
    throw new Error(`the fake chain does not answer ${call.verb}`);
  }
}
