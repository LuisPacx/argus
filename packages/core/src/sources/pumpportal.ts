import { safeUrl } from "./rss.ts";
import type { Signal, Source } from "./source.ts";
import { cleanLink, cleanText, isRecord } from "./untrusted-text.ts";

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
/** A transaction signature is base58, 64 bytes: 86 to 88 characters. */
const SIGNATURE_RE = /^[1-9A-HJ-NP-Za-km-z]{80,90}$/;
const MAX_POOL_CHARS = 30;

/**
 * One create or migrate event as the Study keeps it: the Source's own Signals carry only a title and summary, but the Study needs the
 * metadata `uri`, the creator and the receipt time too. `receivedAt` is when this process got the event; ticket 01 measured it at 0.2 to
 * 1.3 s after the chain time, so it stands in for the chain event time. All text is untrusted and sanitised as the Signals are; a field
 * the event lacked is the empty string.
 */
export interface PumpTokenEvent {
  kind: "create" | "migrate";
  mint: string;
  receivedAt: string;
  signature: string;
  name: string;
  symbol: string;
  creator: string;
  uri: string;
  /** PumpPortal's launchpad/venue tag: `pump` and `bonk` on creates, `pump-amm` on the migrations seen. */
  pool: string;
}

/** The websocket going up or down, for the Study's gap markers: events are missing while it is down. */
export interface PumpConnectionEvent {
  state: "up" | "down";
  at: string;
}

interface ParsedEvent {
  msg: Record<string, unknown>;
  kind: "create" | "migrate";
  mint: string;
}

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
  /** Called synchronously for every create and migrate event, on the one connection this Source holds (the Study's feed). */
  onToken?: (event: PumpTokenEvent) => void;
  /** Called when the connection comes up and when an established one goes down (a drop or `close()`). */
  onConnection?: (event: PumpConnectionEvent) => void;
}

const defaultSchedule = (fn: () => void, ms: number) => {
  const t = setTimeout(fn, ms);
  t.unref();
  return () => clearTimeout(t);
};

/** Remote text: markup removed, trimmed, cut to `max` (the rules the Study's Snapshots share, see untrusted-text.ts). */
const str = cleanText;

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
  private readonly onToken: ((event: PumpTokenEvent) => void) | undefined;
  private readonly onConnection: ((event: PumpConnectionEvent) => void) | undefined;
  /** The open socket has reported `up`, so letting go of it reports `down`. */
  private reportedUp = false;
  /** Keyed by Signal id, so the same token event arriving twice is held once. */
  private buffer = new Map<string, Signal>();
  private socket: SocketLike | undefined;
  private cancelRetry: (() => void) | undefined;
  private failures = 0;
  /** Counts sockets created, so each connection line names its own. */
  private connId = 0;
  private running = false;

  constructor(opts: PumpPortalOptions = {}) {
    this.url = opts.url ?? STREAM_URL;
    this.createSocket = opts.createSocket ?? ((url) => new WebSocket(url) as unknown as SocketLike);
    this.schedule = opts.schedule ?? defaultSchedule;
    this.now = opts.now ?? Date.now;
    this.maxBuffered = opts.maxBuffered ?? MAX_BUFFERED;
    this.maxMessageChars = opts.maxMessageChars ?? MAX_MESSAGE_CHARS;
    this.log = opts.log ?? (() => {});
    this.onToken = opts.onToken;
    this.onConnection = opts.onConnection;
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
    if (ws) this.log(`[pumpportal] closed conn=${this.connId} open=0`);
    this.reportDown();
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
    this.connId++;
    ws.onopen = () => {
      if (this.socket !== ws) return;
      this.reportedUp = true;
      this.log(`[pumpportal] connect conn=${this.connId} open=${this.openCount()}`);
      this.emitConnection("up");
      try {
        ws.send(JSON.stringify({ method: "subscribeNewToken" }));
        ws.send(JSON.stringify({ method: "subscribeMigration" }));
        this.log(`[pumpportal] subscribe conn=${this.connId} streams=newToken,migration`);
      } catch {
        // the close event follows and triggers the retry
      }
    };
    ws.onmessage = (ev) => {
      if (this.socket !== ws) return;
      this.onMessage(ev.data, ws);
    };
    // A failed handshake raises error without close in Node, so an error counts as a drop too.
    ws.onerror = (ev) => this.drop(ws, ev);
    ws.onclose = (ev) => this.drop(ws, ev);
  }

  /** Sockets this Source holds open right now: 0 or 1, by construction; logged so a reader can confirm it. */
  private openCount(): number {
    return this.reportedUp && this.socket ? 1 : 0;
  }

  /** Lets go of a socket (closing it if it is still open) and plans the reconnect. `info` is the close event or a reason of our own. */
  private drop(ws: SocketLike, info?: unknown): void {
    if (this.socket !== ws) return;
    this.socket = undefined;
    const code = isRecord(info) && typeof info.code === "number" ? String(info.code) : "none";
    const reason = typeof info === "string" ? info : isRecord(info) && typeof info.reason === "string" ? info.reason : "";
    this.log(`[pumpportal] disconnect conn=${this.connId} code=${code} reason=${JSON.stringify(cleanText(reason, 120))} open=0`);
    this.reportDown();
    ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
    try {
      ws.close(1000);
    } catch {
      // already closed
    }
    this.retryLater();
  }

  private reportDown(): void {
    if (!this.reportedUp) return;
    this.reportedUp = false;
    this.emitConnection("down");
  }

  private retryLater(): void {
    if (!this.running || this.cancelRetry) return;
    const wait = Math.min(RECONNECT_BASE_MS * 2 ** Math.min(this.failures, 20), RECONNECT_MAX_MS);
    this.failures++;
    this.log(`[pumpportal] reconnect attempt=${this.failures} in=${wait}ms`);
    this.cancelRetry = this.schedule(() => this.connect(), wait);
  }

  private onMessage(data: unknown, ws: SocketLike): void {
    if (typeof data !== "string") return;
    if (data.length > this.maxMessageChars) {
      // Something is wrong with the sender: drop it and start over. (The socket library has already read the frame; this bounds what is kept.)
      this.log("[pumpportal] message too large; resetting the connection");
      this.drop(ws, "message too large");
      return;
    }
    const event = this.parseEvent(data);
    if (!event) return;
    const signal = this.toSignal(event);
    this.failures = 0; // a real event arrived: the next drop starts the wait from the beginning (acks and garbage do not count)
    this.emitToken(event);
    this.buffer.delete(signal.id); // a repeat keeps one entry, at the newest position
    this.buffer.set(signal.id, signal);
    while (this.buffer.size > this.maxBuffered) {
      const oldest = this.buffer.keys().next().value;
      if (oldest === undefined) break;
      this.buffer.delete(oldest);
    }
  }

  private parseEvent(raw: string): ParsedEvent | undefined {
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
    return { msg, kind, mint };
  }

  /** Hands the event to the Study's listener with the fields it keeps. A listener that throws is logged and never affects the Source. */
  private emitToken({ msg, kind, mint }: ParsedEvent): void {
    if (!this.onToken) return;
    const address = (v: unknown) => (typeof v === "string" && MINT_RE.test(v) ? v : "");
    const event: PumpTokenEvent = {
      kind,
      mint,
      receivedAt: new Date(this.now()).toISOString(),
      signature: typeof msg.signature === "string" && SIGNATURE_RE.test(msg.signature) ? msg.signature : "",
      name: str(msg.name, MAX_NAME_CHARS),
      symbol: str(msg.symbol, MAX_SYMBOL_CHARS),
      creator: kind === "create" ? address(msg.traderPublicKey) : "",
      uri: cleanLink(msg.uri),
      pool: str(msg.pool, MAX_POOL_CHARS),
    };
    try {
      this.onToken(event);
    } catch (e) {
      this.log(`[pumpportal] token listener failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private emitConnection(state: "up" | "down"): void {
    try {
      this.onConnection?.({ state, at: new Date(this.now()).toISOString() });
    } catch (e) {
      this.log(`[pumpportal] connection listener failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private toSignal({ msg, kind, mint }: ParsedEvent): Signal {
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
