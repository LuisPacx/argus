import { safeUrl, stripHtml } from "./rss.ts";
import type { Signal, Source } from "./source.ts";

/** PumpPortal's data stream is free and needs no account or key (only its separate trading API does). */
const STREAM_URL = "wss://pumpportal.fun/api/data";
/** A message longer than this is dropped and its connection reset: real events are well under 2 KiB. */
const MAX_MESSAGE_CHARS = 16 * 1024;
/** Events wait here between polls (every 5 minutes); past this the oldest are dropped so a launch flood cannot grow memory. */
const MAX_BUFFERED = 500;
const MAX_NAME_CHARS = 100;
const MAX_SYMBOL_CHARS = 30;
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 5 * 60_000;
/** Solana addresses are base58, 32 to 44 characters. The mint also goes into a link, so nothing else is accepted. */
const MINT_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** The part of the WebSocket API used here (Node's global `WebSocket` fits). */
export interface SocketLike {
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: unknown) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  send(data: string): void;
  close(code?: number): void;
}

export interface PumpPortalOptions {
  url?: string;
  /** Replaces opening the real socket. */
  createSocket?: (url: string) => SocketLike;
  /** Runs `fn` after `ms` and returns a canceller. Tests pass a fake clock. */
  schedule?: (fn: () => void, ms: number) => () => void;
  now?: () => number;
  maxBuffered?: number;
  maxMessageChars?: number;
  log?: (line: string) => void;
}

const defaultSchedule = (fn: () => void, ms: number) => {
  const t = setTimeout(fn, ms);
  t.unref();
  return () => clearTimeout(t);
};

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
/** Remote text: markup removed, trimmed, cut to `max`. */
const str = (v: unknown, max: number): string => (typeof v === "string" ? stripHtml(v).trim().slice(0, max) : "");

/**
 * New pump.fun launches and bonding-curve completions ("migrations"), pushed over PumpPortal's websocket.
 * The socket is held open between polls; `poll()` hands over what arrived since the last one, so it never throws.
 * A dropped connection is retried with a doubling wait; `close()` stops it for good. Every message is untrusted.
 */
export class PumpPortalSource implements Source {
  readonly id = "pumpportal:events";
  readonly label = "PumpPortal";
  private readonly url: string;
  private readonly createSocket: (url: string) => SocketLike;
  private readonly schedule: (fn: () => void, ms: number) => () => void;
  private readonly now: () => number;
  private readonly maxBuffered: number;
  private readonly maxMessageChars: number;
  private readonly log: (line: string) => void;
  /** Keyed by Signal id, so the same token event arriving twice is held once. */
  private buffer = new Map<string, Signal>();
  private socket: SocketLike | undefined;
  private cancelRetry: (() => void) | undefined;
  private failures = 0;
  private running = false;

  constructor(opts: PumpPortalOptions = {}) {
    this.url = opts.url ?? STREAM_URL;
    this.createSocket = opts.createSocket ?? ((url) => new WebSocket(url) as unknown as SocketLike);
    this.schedule = opts.schedule ?? defaultSchedule;
    this.now = opts.now ?? Date.now;
    this.maxBuffered = opts.maxBuffered ?? MAX_BUFFERED;
    this.maxMessageChars = opts.maxMessageChars ?? MAX_MESSAGE_CHARS;
    this.log = opts.log ?? (() => {});
  }

  /** Opens the connection (and keeps it open). Calling it again does nothing. */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.connect();
  }

  /** Closes the socket and cancels any pending retry. Nothing is left running. */
  close(): void {
    this.running = false;
    this.cancelRetry?.();
    this.cancelRetry = undefined;
    const ws = this.socket;
    this.socket = undefined;
    if (ws) {
      ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
      try {
        ws.close(1000);
      } catch {
        // already closed
      }
    }
    this.buffer.clear();
  }

  async poll(): Promise<Signal[]> {
    const out = [...this.buffer.values()];
    this.buffer = new Map();
    return out;
  }

  private connect(): void {
    this.cancelRetry = undefined;
    if (!this.running) return;
    let ws: SocketLike;
    try {
      ws = this.createSocket(this.url);
    } catch (e) {
      this.log(`[pumpportal] could not connect: ${e instanceof Error ? e.message : String(e)}`);
      this.retryLater();
      return;
    }
    this.socket = ws;
    ws.onopen = () => {
      if (this.socket !== ws) return;
      try {
        ws.send(JSON.stringify({ method: "subscribeNewToken" }));
        ws.send(JSON.stringify({ method: "subscribeMigration" }));
      } catch {
        // the close event follows and triggers the retry
      }
    };
    ws.onmessage = (ev) => {
      if (this.socket !== ws) return;
      this.failures = 0; // the connection is alive: the next drop starts the wait from the beginning
      this.onMessage(ev.data, ws);
    };
    // A failed handshake raises error without close in Node, so an error counts as a drop too.
    ws.onerror = () => this.drop(ws);
    ws.onclose = () => this.drop(ws);
  }

  /** Lets go of a socket (closing it if it is still open) and plans the reconnect. */
  private drop(ws: SocketLike): void {
    if (this.socket !== ws) return;
    this.socket = undefined;
    ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
    try {
      ws.close(1000);
    } catch {
      // already closed
    }
    this.retryLater();
  }

  private retryLater(): void {
    if (!this.running || this.cancelRetry) return;
    const wait = Math.min(RECONNECT_BASE_MS * 2 ** Math.min(this.failures, 20), RECONNECT_MAX_MS);
    this.failures++;
    this.cancelRetry = this.schedule(() => this.connect(), wait);
  }

  private onMessage(data: unknown, ws: SocketLike): void {
    if (typeof data !== "string") return;
    if (data.length > this.maxMessageChars) {
      // Something is wrong with the sender: drop it and start over. (The socket library has already read the frame; this bounds what is kept.)
      this.log("[pumpportal] message too large; resetting the connection");
      this.drop(ws);
      return;
    }
    const signal = this.toSignal(data);
    if (!signal) return;
    this.buffer.delete(signal.id); // a repeat keeps one entry, at the newest position
    this.buffer.set(signal.id, signal);
    while (this.buffer.size > this.maxBuffered) {
      const oldest = this.buffer.keys().next().value;
      if (oldest === undefined) break;
      this.buffer.delete(oldest);
    }
  }

  private toSignal(raw: string): Signal | undefined {
    let msg: unknown;
    try {
      msg = JSON.parse(raw);
    } catch {
      return undefined;
    }
    if (!isRecord(msg)) return undefined;
    const kind = msg.txType === "create" ? "create" : msg.txType === "migrate" ? "migrate" : undefined;
    const mint = typeof msg.mint === "string" ? msg.mint : "";
    if (!kind || !MINT_RE.test(mint)) return undefined; // subscription acks and anything else
    const name = str(msg.name, MAX_NAME_CHARS);
    const symbol = str(msg.symbol, MAX_SYMBOL_CHARS);
    const token = name || symbol ? `${name || symbol}${name && symbol ? ` ($${symbol})` : ""}` : `${mint.slice(0, 4)}...${mint.slice(-4)}`;
    return {
      id: `${this.id}:${kind}:${mint}`,
      sourceId: this.id,
      sourceLabel: this.label,
      title: kind === "create" ? `New token on pump.fun: ${token}` : `Bonded on pump.fun: ${token}`,
      summary:
        kind === "create"
          ? `${token} was just launched on pump.fun. Mint ${mint}.`
          : `${token} completed its bonding curve and moved to a swap pool. Mint ${mint}.`,
      url: safeUrl(`https://pump.fun/coin/${mint}`),
      publishedAt: new Date(this.now()).toISOString(),
    };
  }
}
