import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * A fake Anthropic Messages API on loopback, for tests of ApiBrain (CODING_STANDARDS 16: tests never reach the real API, which
 * costs real money). It records every request and answers from a queue of scripted replies; with an empty queue it answers a
 * plain success. Nothing here talks to the network beyond 127.0.0.1.
 */
export interface RecordedRequest {
  method: string;
  path: string;
  /** Header names are lower-case. */
  headers: Record<string, string | string[] | undefined>;
  body: Record<string, unknown>;
}

export type FakeReply =
  /** A JSON body with this HTTP status, after `delayMs` if given. */
  | { status: number; body: unknown; delayMs?: number }
  /** The connection is cut without an answer. */
  | { destroy: true };

export interface FakeUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

/** A Messages API success body. */
export function messageBody(text: string, usage: FakeUsage | null = { input_tokens: 100, output_tokens: 20 }, extra: Record<string, unknown> = {}): Record<string, unknown> {
  const body: Record<string, unknown> = {
    id: "msg_fake",
    type: "message",
    role: "assistant",
    model: "claude-haiku-5-5",
    content: [{ type: "text", text }],
    stop_reason: "end_turn",
    stop_sequence: null,
    ...extra,
  };
  if (usage) body.usage = { cache_creation_input_tokens: 0, cache_read_input_tokens: 0, ...usage };
  return body;
}

export interface FakeAnthropic {
  /** Base URL to give ApiBrain (no trailing slash). */
  readonly url: string;
  readonly requests: RecordedRequest[];
  /** Queues replies, used one per request in order. */
  reply(...replies: FakeReply[]): void;
  close(): Promise<void>;
}

export async function startFakeAnthropic(): Promise<FakeAnthropic> {
  const requests: RecordedRequest[] = [];
  const queue: FakeReply[] = [];
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", (d: string) => (raw += d));
    req.on("end", () => {
      let body: Record<string, unknown> = {};
      try {
        body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      } catch {
        // recorded as an empty body
      }
      requests.push({ method: req.method ?? "", path: req.url ?? "", headers: req.headers, body });
      const next = queue.shift() ?? { status: 200, body: messageBody("{}") };
      if ("destroy" in next) {
        req.socket.destroy();
        return;
      }
      const send = () => {
        if (res.destroyed) return;
        res.writeHead(next.status, { "content-type": "application/json" });
        res.end(JSON.stringify(next.body));
      };
      if (next.delayMs) setTimeout(send, next.delayMs).unref();
      else send();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    reply: (...replies) => void queue.push(...replies),
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
