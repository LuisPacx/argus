/**
 * The one module that talks to the chain (ADR 0002 Amendment, Phase 3): read-only RPC through Helius, per-RPC-verb wrappers only.
 * Nothing here signs, sends, or holds a wallet; the host is pinned below and never configured; no other file may name the host or a verb
 * (`adr-0002.test.ts`). Sampling, parsing and budgeting live elsewhere under `study/` and call these wrappers.
 *
 * Every wrapper takes the key as a plain string (read by the caller from the environment, never logged: errors here carry the key
 * stripped out), returns the typed result, and throws `HeliusError` with a `kind` the callers can act on. Credits are not counted here:
 * `chain-reader.ts` counts them from the cost table below, before and after each call.
 */

export const PINNED_ENDPOINT = "https://mainnet.helius-rpc.com/";

/** The RPC verb of each wrapper, exported so tests assert the sent verb without spelling it. */
export const SIGNATURES_VERB = "getSignaturesForAddress";
export const TX_VERB = "getTransaction";
export const TXS_FOR_ADDRESS_VERB = "getTransactionsForAddress";

/**
 * Credit costs on the Helius plans (the provider's billing docs, checked 2026-11-19): a signatures page and a transaction
 * read cost 1; the history call costs 10 flat for signatures only, and 10 per 100 transactions returned (rounded up, minimum 10) in full.
 */
export const CREDIT_COST = {
  signaturesPage: 1,
  transaction: 1,
  historySignaturesOnly: 10,
  historyFullPer100: 10,
  historyMinimum: 10,
} as const;

export const MAX_SIGNATURES_PAGE = 1000;

/**
 * The highest transaction version the node is asked to return. Version 1 transactions exist on mainnet (2026-11-19: the node refuses a page
 * that holds one unless told it is supported), so 0 is not enough: a page with one such transaction would fail whole.
 */
export const MAX_TX_VERSION = 1;

/** What the history call costs for `returned` items of the given detail. */
export function historyCost(detail: "signatures" | "full", returned: number): number {
  if (detail === "signatures") return CREDIT_COST.historySignaturesOnly;
  return Math.max(CREDIT_COST.historyMinimum, Math.ceil(returned / 100) * CREDIT_COST.historyFullPer100);
}

export interface HeliusClient {
  apiKey: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export type HeliusErrorKind =
  /** HTTP 429 or an RPC rate-limit answer: wait and retry later. */
  | "rate_limited"
  /** A network failure, a timeout or HTTP 5xx: retry later. */
  | "transient"
  /** The key was refused (HTTP 401 or 403): retrying will not help. */
  | "auth"
  /** The server answered but the answer was an RPC error or not the expected shape. */
  | "bad_response";

export class HeliusError extends Error {
  readonly kind: HeliusErrorKind;
  constructor(kind: HeliusErrorKind, message: string) {
    super(message);
    this.name = "HeliusError";
    this.kind = kind;
  }
  get retryable(): boolean {
    return this.kind === "rate_limited" || this.kind === "transient";
  }
}

export interface SignatureInfo {
  signature: string;
  slot: number;
  /** Null for a successful transaction. */
  err: unknown;
  blockTime: number | null;
}

export interface ParsedInstruction {
  programId: string;
  /** Present on instructions the node could not decode: the account addresses. */
  accounts?: string[];
  /** Base58 instruction data, on instructions the node could not decode. */
  data?: string;
}

export interface ParsedTransaction {
  slot: number;
  blockTime: number | null;
  transaction: {
    signatures: string[];
    message: { accountKeys: Array<string | { pubkey: string; signer?: boolean }>; instructions: ParsedInstruction[] };
  };
  meta: {
    err: unknown;
    logMessages?: string[];
    innerInstructions?: Array<{ index: number; instructions: ParsedInstruction[] }>;
  } | null;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Removes the key from any text before it can reach an error message or a log. */
const scrub = (text: string, key: string): string => (key === "" ? text : text.split(key).join("***"));

async function post(client: HeliusClient, body: string): Promise<unknown> {
  const doFetch = client.fetch ?? fetch;
  let res: Response;
  try {
    res = await doFetch(`${PINNED_ENDPOINT}?api-key=${client.apiKey}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      signal: AbortSignal.timeout(client.timeoutMs ?? 30_000),
    });
  } catch (e) {
    throw new HeliusError("transient", scrub(`request failed: ${e instanceof Error ? e.name : "error"}`, client.apiKey));
  }
  if (res.status === 429) throw new HeliusError("rate_limited", "HTTP 429");
  if (res.status === 401 || res.status === 403) throw new HeliusError("auth", `HTTP ${res.status}`);
  if (res.status >= 500) throw new HeliusError("transient", `HTTP ${res.status}`);
  let json: unknown;
  try {
    json = await res.json();
  } catch {
    throw new HeliusError(res.ok ? "bad_response" : "transient", `HTTP ${res.status} with a body that is not JSON`);
  }
  if (isObject(json) && isObject(json.error)) {
    const code = typeof json.error.code === "number" ? json.error.code : 0;
    const message = typeof json.error.message === "string" ? json.error.message.slice(0, 200) : "";
    const kind: HeliusErrorKind = code === -32429 || /rate limit|too many requests/i.test(message) ? "rate_limited" : "bad_response";
    throw new HeliusError(kind, scrub(`RPC error ${code}: ${message}`, client.apiKey));
  }
  if (!res.ok) throw new HeliusError("bad_response", `HTTP ${res.status}`);
  if (!isObject(json) || !("result" in json)) throw new HeliusError("bad_response", "answer has no result");
  return json.result;
}

function toSignatureInfo(v: unknown): SignatureInfo {
  if (!isObject(v) || typeof v.signature !== "string" || typeof v.slot !== "number") throw new HeliusError("bad_response", "a signature entry has the wrong shape");
  return { signature: v.signature, slot: v.slot, err: v.err ?? null, blockTime: typeof v.blockTime === "number" ? v.blockTime : null };
}

function toTransaction(v: unknown): ParsedTransaction {
  if (!isObject(v) || !isObject(v.transaction) || !isObject(v.transaction.message) || !Array.isArray(v.transaction.signatures)) {
    throw new HeliusError("bad_response", "a transaction has the wrong shape");
  }
  return v as unknown as ParsedTransaction;
}

/** One page of signatures for an address, newest first (1 credit). `before` and `until` are signatures. */
export async function getSignaturesForAddress(client: HeliusClient, address: string, opts: { limit?: number; before?: string; until?: string } = {}): Promise<SignatureInfo[]> {
  const options: Record<string, unknown> = { limit: Math.min(MAX_SIGNATURES_PAGE, opts.limit ?? MAX_SIGNATURES_PAGE), commitment: "finalized" };
  if (opts.before) options.before = opts.before;
  if (opts.until) options.until = opts.until;
  const result = await post(client, JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getSignaturesForAddress", params: [address, options] }));
  if (!Array.isArray(result)) throw new HeliusError("bad_response", "signatures answer is not a list");
  return result.map(toSignatureInfo);
}

/** One transaction, parsed, or null when the node does not have it (1 credit). */
export async function getTransaction(client: HeliusClient, signature: string): Promise<ParsedTransaction | null> {
  const options = { encoding: "jsonParsed", maxSupportedTransactionVersion: MAX_TX_VERSION, commitment: "finalized" };
  const result = await post(client, JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getTransaction", params: [signature, options] }));
  return result === null ? null : toTransaction(result);
}

export interface HistoryOptions {
  sortOrder: "asc" | "desc";
  limit: number;
  /** "signatures" is flat 10 credits; "full" is 10 per 100 transactions, minimum 10. */
  detail: "signatures" | "full";
  /** Only successful transactions (default), or any. */
  status?: "succeeded" | "any";
  /** Unix seconds, inclusive lower and exclusive upper bound on the block time. */
  blockTimeFrom?: number;
  blockTimeBefore?: number;
  paginationToken?: string;
}

export interface History<T> {
  data: T[];
  paginationToken: string | null;
}

/** A page of an address's history with a server-side order, limit and filters (10 credits or more). */
export async function getTransactionsForAddress(client: HeliusClient, address: string, opts: HistoryOptions & { detail: "full" }): Promise<History<ParsedTransaction>>;
export async function getTransactionsForAddress(client: HeliusClient, address: string, opts: HistoryOptions & { detail: "signatures" }): Promise<History<SignatureInfo>>;
export async function getTransactionsForAddress(client: HeliusClient, address: string, opts: HistoryOptions): Promise<History<ParsedTransaction> | History<SignatureInfo>> {
  const filters: Record<string, unknown> = { status: opts.status ?? "succeeded" };
  if (opts.blockTimeFrom !== undefined || opts.blockTimeBefore !== undefined) {
    const range: Record<string, number> = {};
    if (opts.blockTimeFrom !== undefined) range.gte = opts.blockTimeFrom;
    if (opts.blockTimeBefore !== undefined) range.lt = opts.blockTimeBefore;
    filters.blockTime = range;
  }
  const options: Record<string, unknown> = {
    transactionDetails: opts.detail,
    sortOrder: opts.sortOrder,
    limit: opts.limit,
    filters,
    encoding: "jsonParsed",
    maxSupportedTransactionVersion: MAX_TX_VERSION,
    commitment: "finalized",
  };
  if (opts.paginationToken) options.paginationToken = opts.paginationToken;
  const result = await post(client, JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getTransactionsForAddress", params: [address, options] }));
  if (!isObject(result) || !Array.isArray(result.data)) throw new HeliusError("bad_response", "history answer has no data list");
  const paginationToken = typeof result.paginationToken === "string" ? result.paginationToken : null;
  if (opts.detail === "signatures") return { data: result.data.map(toSignatureInfo), paginationToken };
  return { data: result.data.map(toTransaction), paginationToken };
}
