import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { writeFileSync } from "node:fs";
import { TelegramNotifier, createNotifier, telegramConfigFromEnv, telegramEnv } from "./telegram.ts";
import { tempPath } from "./testing/temp.ts";

const TOKEN = "123456:SECRET-token_abc";
const CHAT = "-1001234";

interface Seen {
  path: string;
  body: Record<string, unknown>;
}

/** A fake Telegram Bot API on loopback. `script` answers requests in order; once it runs out, every request succeeds. */
class FakeTelegram {
  readonly seen: Seen[] = [];
  script: Array<{ status: number; body?: unknown } | "hang"> = [];
  private readonly server: Server;
  url = "";

  constructor() {
    this.server = createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        this.seen.push({ path: req.url ?? "", body: JSON.parse(raw || "{}") });
        const next = this.script.shift();
        if (next === "hang") return;
        const status = next?.status ?? 200;
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(next?.body ?? (status === 200 ? { ok: true, result: {} } : { ok: false, description: "nope" })));
      });
    });
  }
  async start(): Promise<void> {
    await new Promise<void>((r) => this.server.listen(0, "127.0.0.1", r));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }
  async stop(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise<void>((r) => this.server.close(() => r()));
  }
}

const fakes: FakeTelegram[] = [];
const notifiers: TelegramNotifier[] = [];
afterEach(async () => {
  for (const n of notifiers.splice(0)) n.close();
  for (const f of fakes.splice(0)) await f.stop();
});

async function setup(opts: Partial<ConstructorParameters<typeof TelegramNotifier>[0]> = {}) {
  const api = new FakeTelegram();
  await api.start();
  fakes.push(api);
  const lines: string[] = [];
  const n = new TelegramNotifier({ token: TOKEN, chatId: CHAT, baseUrl: api.url, log: (l) => lines.push(l), backoffMs: [1, 1, 1], ...opts });
  notifiers.push(n);
  return { api, n, lines };
}

describe("telegramConfigFromEnv", () => {
  it("needs both the bot token and the chat id", () => {
    expect(telegramConfigFromEnv({ TELEGRAM_BOT_TOKEN: "t", TELEGRAM_CHAT_ID: "c" })).toEqual({ token: "t", chatId: "c" });
    expect(telegramConfigFromEnv({ TELEGRAM_BOT_TOKEN: "t" })).toBeUndefined();
    expect(telegramConfigFromEnv({ TELEGRAM_CHAT_ID: " " , TELEGRAM_BOT_TOKEN: "t" })).toBeUndefined();
    expect(telegramConfigFromEnv({})).toBeUndefined();
  });
});

describe("telegramEnv (the operator's .env)", () => {
  const withEnvFile = (content: string) => {
    const path = tempPath("dotenv", ".env");
    writeFileSync(path, content);
    return path;
  };
  const FILE = "TELEGRAM_BOT_TOKEN=file-token\nTELEGRAM_CHAT_ID=file-chat\nOTHER=1\n";

  it("takes only the two Telegram names from the file", () => {
    expect(telegramEnv({}, withEnvFile(FILE))).toEqual({ TELEGRAM_BOT_TOKEN: "file-token", TELEGRAM_CHAT_ID: "file-chat" });
  });

  it("a variable that is set wins over the file, and a set-but-empty one masks it", () => {
    const path = withEnvFile(FILE);
    expect(telegramEnv({ TELEGRAM_BOT_TOKEN: "env-token" }, path)).toEqual({ TELEGRAM_BOT_TOKEN: "env-token", TELEGRAM_CHAT_ID: "file-chat" });
    const masked = telegramEnv({ TELEGRAM_BOT_TOKEN: "", TELEGRAM_CHAT_ID: "" }, path);
    expect(telegramConfigFromEnv(masked)).toBeUndefined();
  });

  it("tripwire: with ARGUS_NO_DOTENV set the file is never read, even when it holds a token", () => {
    const path = withEnvFile(FILE);
    expect(telegramEnv({ ARGUS_NO_DOTENV: "1" }, path)).toEqual({});
    expect(telegramConfigFromEnv(telegramEnv({ ARGUS_NO_DOTENV: "1" }, path))).toBeUndefined();
    // a missing file is no error either
    expect(telegramEnv({}, tempPath("absent", ".env"))).toEqual({});
  });

  it("the test run itself sets the marker and points Telegram at a dead loopback port, so every spawned worker inherits both", () => {
    expect(process.env.ARGUS_NO_DOTENV).toBe("1");
    expect(process.env.ARGUS_TELEGRAM_URL).toBe("http://127.0.0.1:1");
  });
});

describe("createNotifier", () => {
  it("is disabled with exactly one warning that names the variables but no value", () => {
    const lines: string[] = [];
    const n = createNotifier({ env: {}, log: (l) => lines.push(l) });
    n.notify("a");
    n.notify("b");
    expect(n.enabled).toBe(false);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("TELEGRAM_BOT_TOKEN");
    expect(lines[0]).toContain("TELEGRAM_CHAT_ID");
  });

  it("in dry-run logs the message instead of sending it, and never touches the network", async () => {
    const lines: string[] = [];
    let fetched = 0;
    const n = createNotifier({
      env: { TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_CHAT_ID: CHAT },
      dryRun: true,
      log: (l) => lines.push(l),
      fetch: (async () => {
        fetched++;
        return new Response("{}");
      }) as typeof fetch,
    });
    n.notify("hello team");
    await n.idle();
    expect(fetched).toBe(0);
    expect(lines.join("\n")).toContain("dry-run");
    expect(lines.join("\n")).toContain("hello team");
    expect(lines.join("\n")).not.toContain(TOKEN);
  });
});

describe("TelegramNotifier", () => {
  it("posts plain text (no parse mode, so untrusted names need no escaping) to the configured chat", async () => {
    const { api, n } = await setup();
    n.notify("<b>*Moon_Cat*</b> [x](http://evil)");
    await n.idle();
    expect(api.seen).toHaveLength(1);
    expect(api.seen[0]!.path).toBe(`/bot${TOKEN}/sendMessage`);
    expect(api.seen[0]!.body).toEqual({ chat_id: CHAT, text: "<b>*Moon_Cat*</b> [x](http://evil)", disable_web_page_preview: true });
  });

  it("cuts a message to Telegram's 4096 character limit", async () => {
    const { api, n } = await setup();
    n.notify("x".repeat(5000));
    await n.idle();
    expect((api.seen[0]!.body.text as string).length).toBe(4096);
  });

  it("sends messages in order", async () => {
    const { api, n } = await setup();
    n.notify("one");
    n.notify("two");
    n.notify("three");
    await n.idle();
    expect(api.seen.map((s) => s.body.text)).toEqual(["one", "two", "three"]);
  });

  it("retries a server error with backoff until it succeeds", async () => {
    const { api, n } = await setup();
    api.script = [{ status: 502 }, { status: 500 }];
    n.notify("hi");
    await n.idle();
    expect(api.seen).toHaveLength(3);
  });

  it("gives up after the retries are used up and moves on to the next message", async () => {
    const { api, n, lines } = await setup({ backoffMs: [1, 1] });
    api.script = [{ status: 500 }, { status: 500 }, { status: 500 }];
    n.notify("lost");
    n.notify("next");
    await n.idle();
    expect(api.seen.map((s) => s.body.text)).toEqual(["lost", "lost", "lost", "next"]);
    expect(lines.join("\n")).toMatch(/giving up/);
  });

  it("does not retry a rejection that cannot change (bad token, wrong chat)", async () => {
    const { api, n } = await setup();
    api.script = [{ status: 401, body: { ok: false, description: "Unauthorized" } }];
    n.notify("hi");
    await n.idle();
    expect(api.seen).toHaveLength(1);
  });

  it("waits out a 429 for the time Telegram asks", async () => {
    const waits: number[] = [];
    const { api, n } = await setup({ sleep: async (ms) => void waits.push(ms) });
    api.script = [{ status: 429, body: { ok: false, parameters: { retry_after: 7 } } }];
    n.notify("hi");
    await n.idle();
    expect(api.seen).toHaveLength(2);
    expect(waits).toEqual([7000]);
  });

  it("notify returns at once: a hanging API never blocks the caller", async () => {
    const { api, n } = await setup({ requestTimeoutMs: 50, backoffMs: [] });
    api.script = ["hang"];
    const t = Date.now();
    n.notify("slow");
    expect(Date.now() - t).toBeLessThan(20);
    await n.idle(); // the request times out and is abandoned
    expect(api.seen).toHaveLength(1);
  });

  it("keeps a bounded queue: when full, the oldest waiting message is dropped and the drop is logged", async () => {
    const { api, n, lines } = await setup({ maxQueue: 2 });
    api.script = ["hang"];
    n.notify("in flight"); // taken by the sender at once
    n.notify("m1");
    n.notify("m2");
    n.notify("m3"); // m1 is dropped
    n.close(); // abandons the hung request
    expect(lines.join("\n")).toMatch(/queue full/);
    expect(lines.filter((l) => /queue full/.test(l))).toHaveLength(1);
    expect(api.seen.length).toBeLessThanOrEqual(1);
  });

  it("never lets the token reach a log line or an error, even when the connection fails", async () => {
    const lines: string[] = [];
    const n = new TelegramNotifier({ token: TOKEN, chatId: CHAT, baseUrl: "http://127.0.0.1:1", log: (l) => lines.push(l), backoffMs: [1] });
    notifiers.push(n);
    n.notify("hi");
    await n.idle();
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.join("\n")).not.toContain(TOKEN);
    expect(lines.join("\n")).not.toContain("SECRET");
  });

  it("redacts the token from the whole cause chain, however deep", async () => {
    const lines: string[] = [];
    const n = new TelegramNotifier({
      token: TOKEN,
      chatId: CHAT,
      log: (l) => lines.push(l),
      backoffMs: [],
      fetch: (async () => {
        const deepest = new Error(`connect failed for /bot${TOKEN}/sendMessage`);
        const middle = new Error("socket error", { cause: new Error("dns", { cause: deepest }) });
        throw new Error("fetch failed", { cause: middle });
      }) as unknown as typeof fetch,
    });
    notifiers.push(n);
    n.notify("hi");
    await n.idle();
    expect(lines.join("\n")).not.toContain("SECRET");
    expect(lines.join("\n")).toContain("connect failed for /bot[redacted]");
  });

  it("redacts the token from a failing fetch that echoes the URL, and from Telegram's own error text", async () => {
    const lines: string[] = [];
    const n = new TelegramNotifier({
      token: TOKEN,
      chatId: CHAT,
      log: (l) => lines.push(l),
      backoffMs: [],
      fetch: (async (url: string) => {
        throw new Error(`request to ${url} failed, token ${TOKEN}`);
      }) as unknown as typeof fetch,
    });
    notifiers.push(n);
    n.notify("hi");
    await n.idle();
    expect(lines.join("\n")).not.toContain("SECRET");
    expect(lines.join("\n")).toContain("[redacted]");
  });
});
