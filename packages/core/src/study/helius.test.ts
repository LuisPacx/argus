import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { FakeChain, TEST_KEY, fakeCreateTx, fakeMint } from "../testing/fake-chain.ts";
import * as helius from "./helius.ts";
import {
  CREDIT_COST,
  HeliusError,
  MAX_TX_VERSION,
  PINNED_ENDPOINT,
  SIGNATURES_VERB,
  TXS_FOR_ADDRESS_VERB,
  TX_VERB,
  getSignaturesForAddress,
  getTransaction,
  getTransactionsForAddress,
  historyCost,
} from "./helius.ts";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures");
const fixtureFetch = (file: string, status = 200): typeof fetch => async () => new Response(readFileSync(join(FIXTURES, file), "utf8"), { status });
const client = (chain: FakeChain) => ({ apiKey: TEST_KEY, fetch: chain.fetch });

describe("helius.ts: per-verb wrappers on the pinned endpoint", () => {
  it("exports one wrapper per verb and no generic way to send a verb", () => {
    const functions = Object.values(helius).filter((v) => typeof v === "function");
    expect(new Set(functions)).toEqual(new Set([getSignaturesForAddress, getTransaction, getTransactionsForAddress, historyCost, HeliusError]));
    // none of them takes a verb as an argument: the verb is fixed by the wrapper
    expect(getSignaturesForAddress.length).toBeLessThanOrEqual(3);
    expect(getTransaction.length).toBe(2);
  });

  it("each wrapper posts its own verb to the pinned endpoint with the key in the query, and only reads", async () => {
    const chain = new FakeChain();
    const tx = fakeCreateTx({ n: 1, blockTime: 1_700_000_000 });
    chain.addToAddress(tx);
    chain.earliestByMint.set(fakeMint(1), tx);
    await getSignaturesForAddress(client(chain), "Addr".padEnd(44, "a"));
    await getTransaction(client(chain), tx.transaction.signatures[0]!);
    await getTransactionsForAddress(client(chain), fakeMint(1), { sortOrder: "asc", limit: 1, detail: "full" });
    expect(chain.calls.map((c) => c.verb)).toEqual([SIGNATURES_VERB, TX_VERB, TXS_FOR_ADDRESS_VERB]);
    expect(PINNED_ENDPOINT.startsWith("https://")).toBe(true);
    expect(PINNED_ENDPOINT.endsWith("/")).toBe(true);
  });

  it("accepts transaction versions up to 1: a version-1 transaction on mainnet fails a whole page otherwise", async () => {
    const chain = new FakeChain();
    chain.addToAddress(fakeCreateTx({ n: 1, blockTime: 1 }));
    await getTransaction(client(chain), "Sig1".padEnd(88, "z"));
    await getTransactionsForAddress(client(chain), fakeMint(1), { sortOrder: "desc", limit: 5, detail: "full" });
    expect(MAX_TX_VERSION).toBe(1);
    for (const call of chain.calls) expect(call.params.maxSupportedTransactionVersion).toBe(MAX_TX_VERSION);
  });

  it("pages signatures with before, caps the page at 1000, and keeps failed entries visible", async () => {
    const chain = new FakeChain();
    for (let i = 0; i < 5; i++) chain.addToAddress(fakeCreateTx({ n: i, blockTime: 1_700_000_000 - i, failed: i === 2 }), i !== 2);
    const first = await getSignaturesForAddress(client(chain), "Addr".padEnd(44, "a"), { limit: 5000 });
    expect(chain.calls[0]!.params.limit).toBe(1000);
    expect(first.map((s) => s.err === null)).toEqual([true, true, false, true, true]);
    const after = await getSignaturesForAddress(client(chain), "Addr".padEnd(44, "a"), { before: first[1]!.signature });
    expect(chain.calls[1]!.params.before).toBe(first[1]!.signature);
    expect(after).toHaveLength(3);
  });

  it("parses a recorded signatures page and a recorded ascending history answer", async () => {
    const page = await getSignaturesForAddress({ apiKey: TEST_KEY, fetch: fixtureFetch("helius-signatures-page.json") }, "Addr".padEnd(44, "a"));
    expect(page.length).toBe(60);
    expect(page.some((s) => s.err !== null)).toBe(true);
    expect(page[0]).toMatchObject({ signature: expect.any(String) as string, slot: expect.any(Number) as number, blockTime: expect.any(Number) as number });
    const h = await getTransactionsForAddress({ apiKey: TEST_KEY, fetch: fixtureFetch("helius-history-earliest.json") }, fakeMint(1), { sortOrder: "asc", limit: 1, detail: "full" });
    expect(h.data).toHaveLength(1);
    expect(h.data[0]!.meta?.err).toBeNull();
  });

  it("sends the history filters: succeeded only by default, an optional block-time range, ascending order, the limit", async () => {
    const chain = new FakeChain();
    await getTransactionsForAddress(client(chain), fakeMint(1), { sortOrder: "asc", limit: 1, detail: "full" });
    await getTransactionsForAddress(client(chain), fakeMint(1), { sortOrder: "desc", limit: 7, detail: "signatures", status: "any", blockTimeFrom: 10, blockTimeBefore: 20, paginationToken: "tok" });
    expect(chain.calls[0]!.params).toMatchObject({ sortOrder: "asc", limit: 1, transactionDetails: "full", filters: { status: "succeeded" } });
    expect(chain.calls[1]!.params).toMatchObject({ sortOrder: "desc", limit: 7, transactionDetails: "signatures", paginationToken: "tok", filters: { status: "any", blockTime: { gte: 10, lt: 20 } } });
  });

  it("returns null for a transaction the node does not have", async () => {
    expect(await getTransaction(client(new FakeChain()), "Missing".padEnd(88, "z"))).toBeNull();
  });
});

describe("helius.ts: errors", () => {
  const verbs: Array<[string, (c: FakeChain) => Promise<unknown>]> = [
    ["signatures", (c) => getSignaturesForAddress(client(c), "Addr".padEnd(44, "a"))],
    ["transaction", (c) => getTransaction(client(c), "Sig".padEnd(88, "z"))],
    ["history", (c) => getTransactionsForAddress(client(c), fakeMint(1), { sortOrder: "asc", limit: 1, detail: "full" })],
  ];

  it.each(verbs)("%s: HTTP 429 is rate_limited, 5xx and a body that is not JSON are transient, 401 is auth, an RPC error is bad_response", async (_, call) => {
    const expectKind = async (failure: "rate_limit" | "server_error" | "auth" | "rpc_error" | "not_json", kind: string, retryable: boolean) => {
      const chain = new FakeChain();
      chain.failure = () => failure;
      const e = await call(chain).catch((x: unknown) => x);
      expect(e).toBeInstanceOf(HeliusError);
      expect((e as HeliusError).kind, failure).toBe(kind);
      expect((e as HeliusError).retryable, failure).toBe(retryable);
    };
    await expectKind("rate_limit", "rate_limited", true);
    await expectKind("server_error", "transient", true);
    await expectKind("not_json", "bad_response", false);
    await expectKind("auth", "auth", false);
    await expectKind("rpc_error", "bad_response", false);
  });

  it("a network failure is transient and the error text never holds the key", async () => {
    const boom: typeof fetch = async (url) => {
      throw new TypeError(`fetch failed for ${String(url)}`);
    };
    const e = await getTransaction({ apiKey: TEST_KEY, fetch: boom }, "Sig".padEnd(88, "z")).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(HeliusError);
    expect((e as HeliusError).kind).toBe("transient");
    expect(String((e as HeliusError).message)).not.toContain(TEST_KEY);
    const rpcError: typeof fetch = async () => Response.json({ id: 1, error: { code: -32000, message: `bad key ${TEST_KEY} here` } });
    const e2 = await getTransaction({ apiKey: TEST_KEY, fetch: rpcError }, "Sig".padEnd(88, "z")).catch((x: unknown) => x);
    expect(String((e2 as HeliusError).message)).not.toContain(TEST_KEY);
  });

  it("an answer of the wrong shape is bad_response, not a crash", async () => {
    const wrong: typeof fetch = async () => Response.json({ id: 1, result: [{ nonsense: true }] });
    const e = await getSignaturesForAddress({ apiKey: TEST_KEY, fetch: wrong }, "Addr".padEnd(44, "a")).catch((x: unknown) => x);
    expect((e as HeliusError).kind).toBe("bad_response");
  });
});

describe("helius.ts: credit costs (checked against the Helius Free plan docs on 2026-11-19)", () => {
  it("prices the three verbs", () => {
    expect(CREDIT_COST.signaturesPage).toBe(1);
    expect(CREDIT_COST.transaction).toBe(1);
    expect(historyCost("signatures", 1000)).toBe(10);
    expect(historyCost("full", 1)).toBe(10);
    expect(historyCost("full", 100)).toBe(10);
    expect(historyCost("full", 250)).toBe(30);
  });
});
