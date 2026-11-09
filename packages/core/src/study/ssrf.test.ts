import { describe, expect, it } from "vitest";
import { checkFetchUrl, isBlockedAddress } from "./ssrf.ts";

describe("isBlockedAddress", () => {
  it.each([
    "0.0.0.0",
    "10.1.2.3",
    "100.64.0.1",
    "127.0.0.1",
    "127.255.255.254",
    "169.254.169.254", // cloud metadata
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "192.0.0.8",
    "198.18.0.1",
    "224.0.0.1",
    "240.0.0.1",
    "255.255.255.255",
    "::",
    "::1",
    "fe80::1",
    "fd00:ec2::254", // AWS IPv6 metadata (unique local)
    "fc00::1",
    "ff02::1",
    "::ffff:127.0.0.1", // IPv4-mapped
    "::ffff:7f00:1", // IPv4-mapped, hex form
    "::ffff:169.254.169.254",
    "64:ff9b::7f00:1", // NAT64 around loopback
    "2002:7f00:1::1", // 6to4 around loopback
    "2001:db8::1",
    "fe80::1%eth0",
  ])("blocks %s", (ip) => expect(isBlockedAddress(ip)).toBe(true));

  it.each(["8.8.8.8", "1.1.1.1", "172.15.255.255", "172.32.0.1", "100.63.255.255", "93.184.216.34", "2606:4700:4700::1111", "2a00:1450:4001:81b::200e", "::ffff:8.8.8.8"])("allows %s", (ip) =>
    expect(isBlockedAddress(ip)).toBe(false),
  );

  it("treats anything that is not an IP address as blocked", () => {
    expect(isBlockedAddress("not-an-ip")).toBe(true);
    expect(isBlockedAddress("")).toBe(true);
  });
});

describe("checkFetchUrl", () => {
  it("accepts a plain public http(s) URL", () => {
    expect(checkFetchUrl("https://example.com/path?q=1")).toEqual({ ok: true, url: new URL("https://example.com/path?q=1") });
    expect(checkFetchUrl("http://example.com:80/")).toMatchObject({ ok: true });
    expect(checkFetchUrl("https://93.184.216.34/")).toMatchObject({ ok: true });
  });

  it.each([
    ["file:///etc/passwd", /scheme/],
    ["ftp://example.com/", /scheme/],
    ["gopher://example.com/", /scheme/],
    ["javascript:alert(1)", /scheme/],
    ["not a url", /invalid/],
    ["https://user:pw@example.com/", /credentials/],
    ["https://example.com:6379/", /port/],
    ["http://127.0.0.1/", /address/],
    ["http://[::1]/", /address/],
    ["http://[::ffff:127.0.0.1]/", /address/],
    ["http://169.254.169.254/latest/meta-data/", /address/],
    ["http://2130706433/", /address/], // decimal form of 127.0.0.1
    ["http://0x7f000001/", /address/], // hex form
    ["http://0177.0.0.1/", /address/], // octal form
    ["http://127.1/", /address/], // short form
    ["http://10.0.0.1/", /address/],
    ["http://localhost/", /host/],
    ["http://LOCALHOST./", /host/],
    ["http://foo.localhost/", /host/],
    ["http://metadata.google.internal/", /host/],
    ["http://printer.local/", /host/],
    ["http://intranet/", /host/], // single label: resolves through the search domain
  ])("refuses %s", (raw, why) => {
    const r = checkFetchUrl(raw);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(why);
  });

  it("refuses a URL over 2000 characters", () => {
    expect(checkFetchUrl(`https://example.com/${"a".repeat(2000)}`)).toMatchObject({ ok: false });
  });
});
