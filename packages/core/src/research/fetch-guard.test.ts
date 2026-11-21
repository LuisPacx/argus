import { describe, expect, it } from "vitest";
import { ClaudeCodeBrain, DEFAULT_ROUTING, type Routing } from "../brain.ts";
import { checkResearchUrl, decideHook, DENIED_FETCH_DOMAINS, fetchDenyRules, fetchGuardSettings, ownHostNames, type FetchGuardDeps } from "./fetch-guard.ts";

// Human researcher ticket 12 (b): what a research run's WebFetch may reach. No live call and no real DNS: names resolve through a table the test passes in.
const TABLE: Record<string, string[]> = {
  "en.wikipedia.org": ["208.80.154.224", "2620:0:861:ed1a::1"],
  "rebind.example": ["127.0.0.1"],
  "mixed.example": ["93.184.216.34", "10.0.0.7"],
  "lan.example": ["192.168.1.20"],
  "meta.example": ["169.254.169.254"],
  "v6local.example": ["::1"],
  "mapped.example": ["::ffff:127.0.0.1"],
  "empty.example": [],
};
const deps: FetchGuardDeps = {
  own: ["localhost", "warroom-box"],
  resolve: async (host) => {
    const a = TABLE[host];
    if (a === undefined) throw new Error("ENOTFOUND");
    return a;
  },
};
const ask = (url: unknown) => checkResearchUrl(url, deps);

describe("a research run refuses the machine's own network", () => {
  it.each([
    ["localhost", "http://localhost/"],
    ["localhost on the War Room's port", "http://localhost:3100/"],
    ["localhost, https", "https://localhost/api/research"],
    ["a subdomain of localhost", "http://anything.localhost/"],
    ["localhost with a trailing dot", "http://localhost./"],
    ["localhost in capitals", "http://LOCALHOST/"],
    ["loopback", "http://127.0.0.1/"],
    ["loopback, other octets", "http://127.5.6.7/"],
    ["loopback, short form", "http://127.1/"],
    ["loopback, decimal form", "http://2130706433/"],
    ["loopback, hex form", "http://0x7f000001/"],
    ["loopback, octal form", "http://0177.0.0.1/"],
    ["loopback, bracketed IPv6", "http://[::1]/"],
    ["loopback, bracketed IPv6 with a port", "http://[::1]:3100/"],
    ["loopback, IPv4-mapped IPv6", "http://[::ffff:127.0.0.1]/"],
    ["loopback, IPv4-mapped IPv6 in hex", "http://[::ffff:7f00:1]/"],
    ["the any address", "http://0.0.0.0/"],
    ["a private 10/8 address", "http://10.1.2.3/"],
    ["a private 172.16/12 address", "http://172.16.0.1/"],
    ["a private 192.168/16 address", "http://192.168.1.1/admin"],
    ["a private address, decimal form", "http://3232235777/"],
    ["a carrier-grade NAT address", "http://100.64.0.1/"],
    ["the cloud metadata address", "http://169.254.169.254/latest/meta-data/"],
    ["a link-local address, hex form", "http://0xa9fea9fe/"],
    ["a link-local IPv6 address", "http://[fe80::1]/"],
    ["a unique-local IPv6 address", "http://[fd00::1]/"],
    ["a name with no dot (a LAN host)", "http://router/"],
    ["a .local name", "http://printer.local/"],
    ["a .internal name", "http://db.internal/"],
    ["this machine by name", "http://warroom-box/"],
    ["this machine by a dotted name", "https://WARROOM-BOX./x"],
    ["a name that resolves to loopback", "https://rebind.example/"],
    ["a name that resolves to a private address", "https://lan.example/"],
    ["a name that resolves to the metadata address", "https://meta.example/"],
    ["a name that resolves to IPv6 loopback", "https://v6local.example/"],
    ["a name that resolves to a mapped loopback", "https://mapped.example/"],
    ["a name that resolves to one public and one private address", "https://mixed.example/"],
    ["a name that does not resolve", "https://nowhere.example/"],
    ["a name that resolves to nothing", "https://empty.example/"],
    ["a file address", "file:///etc/passwd"],
    ["an odd scheme", "gopher://93.184.216.34/"],
    ["a script scheme", "javascript:alert(1)"],
    ["credentials that make a host look like another", "https://en.wikipedia.org@127.0.0.1/"],
    ["a public address on the War Room's port", "http://93.184.216.34:3100/"],
    ["localhost with no scheme", "localhost:3100/x"],
    ["loopback with no scheme", "127.0.0.1:3100"],
    ["a very long address", ["https", `${"a".repeat(3000)}.example/`].join("://")],
    ["an empty value", ""],
    ["a value that is not a string", 42],
    ["a missing value", undefined],
  ])("%s", async (_label, url) => {
    const v = await ask(url);
    expect(v.allow, JSON.stringify(v)).toBe(false);
  });

  it.each([
    ["a public IPv4 address", "https://93.184.216.34/page"],
    ["a public IPv4 address, decimal form", "http://1572395042/"],
    ["a public IPv6 address, bracketed", "https://[2606:2800:220:1:248:1893:25c8:1946]/"],
    ["a public name", "https://en.wikipedia.org/wiki/Grand_Theft_Auto_VI"],
    ["a public name, no scheme", "en.wikipedia.org/wiki/GTA"],
    ["a public name with a query", "https://en.wikipedia.org/w/index.php?search=gta&x=1"],
  ])("still lets %s through", async (_label, url) => {
    expect(await ask(url)).toEqual({ allow: true });
  });

  it("gives the reason, and never throws on a resolver that does", async () => {
    expect(await ask("http://localhost/")).toMatchObject({ allow: false, reason: expect.stringContaining("localhost") });
    expect(await ask("https://rebind.example/")).toMatchObject({ allow: false, reason: expect.stringContaining("127.0.0.1") });
    const boom: FetchGuardDeps = { own: [], resolve: () => Promise.reject(new Error("boom")) };
    expect(await checkResearchUrl("https://en.wikipedia.org/", boom)).toMatchObject({ allow: false });
  });

  it("refuses a public-looking name that is this machine's own", async () => {
    const own: FetchGuardDeps = { own: ["warroom.example.com"], resolve: async () => ["93.184.216.34"] };
    expect(await checkResearchUrl("https://warroom.example.com/", own)).toMatchObject({ allow: false, reason: expect.stringContaining("this machine") });
    expect(await checkResearchUrl("https://other.example.com/", own)).toEqual({ allow: true });
  });

  it("knows this machine's own name", () => {
    expect(ownHostNames()).toContain("localhost");
  });
});

describe("the hook's decision from the CLI's stdin", () => {
  const call = (tool: string, url: unknown) => JSON.stringify({ tool_name: tool, tool_input: { url } });
  it("refuses a localhost fetch and allows a public one", async () => {
    expect((await decideHook(call("WebFetch", "http://localhost:3100/api/picks"), deps)).allow).toBe(false);
    expect((await decideHook(call("WebFetch", "https://en.wikipedia.org/wiki/GTA"), deps)).allow).toBe(true);
  });
  it("refuses what it cannot read, and a tool it was not made for", async () => {
    for (const s of ["", "not json", "null", "[]", "{}", call("WebFetch", undefined), call("WebFetch", ["http://localhost/"]), call("Bash", "https://en.wikipedia.org/")]) {
      expect((await decideHook(s, deps)).allow, s).toBe(false);
    }
  });
});

describe("the command a research run is started with", () => {
  const argsOf = (task: "researcher" | "propose" | "judge", routing?: Routing) => new ClaudeCodeBrain({ dryRun: true, routing }).buildArgs(task, { prompt: "p" });
  const value = (args: string[], flag: string) => args[args.indexOf(flag) + 1]!;

  it("denies the local hosts by the CLI's own rules, `WebFetch(domain:host)`, with deny rules for localhost and the metadata address", () => {
    const rules = value(argsOf("researcher"), "--disallowedTools").split(",");
    expect(rules).toEqual(fetchDenyRules());
    for (const d of DENIED_FETCH_DOMAINS) expect(rules).toContain(`WebFetch(domain:${d})`);
    expect(rules).toContain("WebFetch(domain:localhost)");
    expect(rules).toContain("WebFetch(domain:169.254.169.254)");
    for (const r of rules) expect(r).toMatch(/^WebFetch\(domain:[a-z0-9.*-]+\)$/);
  });

  it("installs the guard hook on WebFetch, and keeps the tool set as it was", () => {
    const args = argsOf("researcher");
    expect(value(args, "--tools")).toBe("WebSearch,WebFetch");
    const settings = JSON.parse(value(args, "--settings")) as { hooks: { PreToolUse: { matcher: string; hooks: { type: string; command: string }[] }[] } };
    expect(settings.hooks.PreToolUse).toHaveLength(1);
    const [entry] = settings.hooks.PreToolUse;
    expect(entry!.matcher).toBe("WebFetch");
    expect(entry!.hooks[0]!.type).toBe("command");
    expect(entry!.hooks[0]!.command).toContain("research/fetch-guard-hook.ts");
    expect(entry!.hooks[0]!.command.endsWith("|| exit 2")).toBe(true); // a hook that cannot start blocks the fetch
    expect(args).toContain("--setting-sources"); // the operator's own settings stay out
  });

  it("the other web task, propose, gets it too; a task with no WebFetch gets neither flag", () => {
    expect(argsOf("propose")).toContain("--disallowedTools");
    expect(argsOf("propose")).toContain("--settings");
    expect(argsOf("judge")).not.toContain("--disallowedTools");
    expect(argsOf("judge")).not.toContain("--settings");
  });

  it("a routing override that keeps WebFetch cannot drop it", () => {
    const routing: Routing = { ...DEFAULT_ROUTING, researcher: { ...DEFAULT_ROUTING.researcher, maxBudgetUsd: 0.1, tools: ["WebFetch"] } };
    const args = argsOf("researcher", routing);
    expect(args).toContain("--disallowedTools");
    expect(args).toContain("--settings");
  });

  it("refuses to build a hook command from a path it cannot quote", () => {
    expect(() => fetchGuardSettings("/usr/bin/node", "/tmp/it's/hook.ts")).toThrow();
  });
});
