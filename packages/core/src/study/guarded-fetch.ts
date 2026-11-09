import { lookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { checkFetchUrl, isBlockedAddress } from "./ssrf.ts";

/** HTTP GET for URLs a token's creator chose: SSRF-guarded on every hop, size-capped, time-capped. Bodies are untrusted. */

export const STUDY_USER_AGENT = "ArgusStudy/1 (read-only snapshot, one page per site; honours robots.txt)";
const MAX_REDIRECTS = 3;

export interface TransportRequest {
  url: URL;
  /** The address `guardedGet` validated; the transport connects to exactly this, never to a fresh DNS answer. */
  address: string;
  headers: Record<string, string>;
  signal: AbortSignal;
}

export interface TransportResponse {
  status: number;
  /** Lower-case header names. */
  headers: Record<string, string | undefined>;
  body: AsyncIterable<Uint8Array>;
  destroy(): void;
}

export type Transport = (req: TransportRequest) => Promise<TransportResponse>;
export type Resolver = (hostname: string) => Promise<string[]>;

export interface GuardedGetOptions {
  maxBytes: number;
  timeoutMs: number;
  /** An outer deadline shared with other requests (website + robots); this call's own timeout still applies. */
  signal?: AbortSignal;
  maxRedirects?: number;
  headers?: Record<string, string>;
  resolve?: Resolver;
  transport?: Transport;
  /** Called with each URL (the first and every redirect target) before anything is sent to it; returns a reason to refuse it. */
  beforeRequest?: (url: URL, signal: AbortSignal) => Promise<string | undefined>;
}

export type GuardedResult =
  | { ok: true; status: number; headers: Record<string, string | undefined>; body: Buffer; truncated: boolean; finalUrl: string; elapsedMs: number }
  | { ok: false; reason: "blocked" | "refused" | "timeout" | "redirect-limit" | "error"; detail: string };

const defaultResolve: Resolver = async (hostname) => (await lookup(hostname, { all: true, verbatim: true })).map((a) => a.address);

/** The real wire: plain node http(s), connecting to the validated address, certificate checked against the host name. */
export const nodeTransport: Transport = (req) =>
  new Promise<TransportResponse>((resolve, reject) => {
    const secure = req.url.protocol === "https:";
    const host = req.url.hostname.replace(/^\[|\]$/g, "");
    const r = (secure ? httpsRequest : httpRequest)(
      {
        host: req.address,
        port: req.url.port || (secure ? 443 : 80),
        path: `${req.url.pathname}${req.url.search}`,
        method: "GET",
        headers: req.headers,
        signal: req.signal,
        ...(secure && isIP(host) === 0 ? { servername: host } : {}),
      },
      (res) => {
        const headers: Record<string, string | undefined> = {};
        for (const [k, v] of Object.entries(res.headers)) headers[k] = Array.isArray(v) ? v.join(", ") : v;
        resolve({ status: res.statusCode ?? 0, headers, body: res, destroy: () => res.destroy() });
      },
    );
    r.on("error", reject);
    r.end();
  });

class Aborted extends Error {}

/** Rejects as soon as `signal` aborts, whatever the promise does. */
function abortable<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new Aborted());
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new Aborted());
    signal.addEventListener("abort", onAbort, { once: true });
    p.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

const REDIRECT = new Set([301, 302, 303, 307, 308]);

export async function guardedGet(rawUrl: string, opts: GuardedGetOptions): Promise<GuardedResult> {
  const resolve = opts.resolve ?? defaultResolve;
  const transport = opts.transport ?? nodeTransport;
  const maxRedirects = opts.maxRedirects ?? MAX_REDIRECTS;
  const own = new AbortController();
  const timer = setTimeout(() => own.abort(), opts.timeoutMs);
  const signal = opts.signal ? AbortSignal.any([own.signal, opts.signal]) : own.signal;
  const started = Date.now();
  let response: TransportResponse | undefined;
  try {
    let current = rawUrl;
    for (let hop = 0; ; hop++) {
      const checked = checkFetchUrl(current);
      if (!checked.ok) return { ok: false, reason: "blocked", detail: checked.reason };
      const url = checked.url;
      const refusal = await abortable(opts.beforeRequest?.(url, signal) ?? Promise.resolve(undefined), signal);
      if (refusal !== undefined) return { ok: false, reason: "refused", detail: refusal };
      const hostname = url.hostname.replace(/^\[|\]$/g, "");
      // Every address the name resolves to must be public, and the connection goes to one of those, so a later DNS answer cannot redirect it.
      const addresses = isIP(hostname) !== 0 ? [hostname] : await abortable(resolve(hostname), signal);
      if (addresses.length === 0) return { ok: false, reason: "error", detail: `no address for ${hostname}` };
      const bad = addresses.find(isBlockedAddress);
      if (bad !== undefined) return { ok: false, reason: "blocked", detail: `${hostname} resolves to non-public address ${bad}` };
      const address = addresses.find((a) => isIP(a) === 4) ?? addresses[0]!;
      response = await abortable(
        transport({
          url,
          address,
          signal,
          headers: { host: url.host, "user-agent": STUDY_USER_AGENT, accept: "*/*", "accept-encoding": "identity", ...opts.headers },
        }),
        signal,
      );
      const location = response.headers.location;
      if (REDIRECT.has(response.status) && location) {
        response.destroy();
        response = undefined;
        if (hop >= maxRedirects) return { ok: false, reason: "redirect-limit", detail: `more than ${maxRedirects} redirects` };
        try {
          current = new URL(location, url).href;
        } catch {
          return { ok: false, reason: "blocked", detail: "invalid redirect target" };
        }
        continue;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      let truncated = false;
      const it = response.body[Symbol.asyncIterator]();
      for (;;) {
        const { done, value } = await abortable(it.next(), signal);
        if (done) break;
        const room = opts.maxBytes - size;
        if (value.byteLength > room) {
          if (room > 0) chunks.push(Buffer.from(value.subarray(0, room)));
          size = opts.maxBytes;
          truncated = true;
          break;
        }
        chunks.push(Buffer.from(value));
        size += value.byteLength;
        // A body of exactly the cap is complete only if the stream ends; peek no further than the cap.
        if (size === opts.maxBytes) {
          const next = await abortable(it.next(), signal);
          truncated = !next.done;
          break;
        }
      }
      response.destroy();
      return { ok: true, status: response.status, headers: response.headers, body: Buffer.concat(chunks), truncated, finalUrl: url.href, elapsedMs: Date.now() - started };
    }
  } catch (e) {
    return e instanceof Aborted || signal.aborted ? { ok: false, reason: "timeout", detail: `no complete answer within ${opts.timeoutMs} ms` } : { ok: false, reason: "error", detail: e instanceof Error ? e.message : String(e) };
  } finally {
    clearTimeout(timer);
    response?.destroy();
  }
}
