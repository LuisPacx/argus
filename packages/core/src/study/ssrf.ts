import { isIP } from "node:net";

/**
 * The SSRF guard for every fetch of a URL a token's creator chose (metadata uri, website). A creator can point a URL at anything,
 * so a URL is fetched only if it is plain http(s) on a default port, names a public host, and every address that host resolves to
 * is public. The same check runs again on each redirect and on the address actually connected to (see guarded-fetch.ts).
 */

const MAX_URL_CHARS = 2_000;
const ALLOWED_PORTS = new Set(["", "80", "443"]);
/** Host names that mean "this machine or its network" whatever they resolve to. */
const INTERNAL_SUFFIXES = [".localhost", ".local", ".internal", ".lan", ".home", ".corp", ".intranet", ".localdomain"];

export type UrlCheck = { ok: true; url: URL } | { ok: false; reason: string };

/** The four bytes of a dotted IPv4 address, or undefined. */
function parseIPv4(ip: string): number[] | undefined {
  const parts = ip.split(".");
  if (parts.length !== 4) return undefined;
  const bytes = parts.map((p) => (/^\d{1,3}$/.test(p) ? Number(p) : NaN));
  return bytes.every((b) => b >= 0 && b <= 255) ? bytes : undefined;
}

/** Eight 16-bit groups of an IPv6 address (no zone), or undefined. */
function parseIPv6(ip: string): number[] | undefined {
  let text = ip;
  const dotted = /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(text);
  if (dotted) {
    const v4 = parseIPv4(dotted[1]!);
    if (!v4) return undefined;
    text = `${text.slice(0, dotted.index)}${((v4[0]! << 8) | v4[1]!).toString(16)}:${((v4[2]! << 8) | v4[3]!).toString(16)}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return undefined;
  const groups = (s: string) => (s === "" ? [] : s.split(":"));
  const head = groups(halves[0]!);
  const tail = halves.length === 2 ? groups(halves[1]!) : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  if (fill < (halves.length === 2 ? 1 : 0)) return undefined;
  const all = [...head, ...Array<string>(fill).fill("0"), ...tail];
  if (all.length !== 8) return undefined;
  const nums = all.map((g) => (/^[0-9a-fA-F]{1,4}$/.test(g) ? parseInt(g, 16) : NaN));
  return nums.some(Number.isNaN) ? undefined : nums;
}

function blockedIPv4([a, b, c]: number[]): boolean {
  return (
    a === 0 ||
    a === 10 ||
    (a === 100 && b! >= 64 && b! <= 127) ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b! >= 16 && b! <= 31) ||
    (a === 192 && b === 0 && (c === 0 || c === 2)) ||
    (a === 192 && b === 88 && c === 99) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a! >= 224 // multicast, reserved, broadcast
  );
}

/** True for any loopback, private, link-local (cloud metadata), reserved or multicast address, and for anything that is not an IP. */
export function isBlockedAddress(ip: string): boolean {
  if (ip.includes("%")) return true; // a zone id means a link-local interface
  const kind = isIP(ip);
  if (kind === 4) return blockedIPv4(parseIPv4(ip)!);
  if (kind !== 6) return true;
  const g = parseIPv6(ip);
  if (!g) return true;
  const embedded = (hi: number, lo: number) => [hi >> 8, hi & 0xff, lo >> 8, lo & 0xff];
  if (g.every((x) => x === 0)) return true; // ::
  if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return true; // ::1
  if (g.slice(0, 6).every((x) => x === 0)) return true; // IPv4-compatible ::a.b.c.d (deprecated, never a public host)
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) return blockedIPv4(embedded(g[6]!, g[7]!)); // IPv4-mapped
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) return blockedIPv4(embedded(g[6]!, g[7]!)); // NAT64
  if (g[0] === 0x64 && g[1] === 0xff9b && g[2] === 1) return true; // local-use NAT64
  if (g[0] === 0x2002) return blockedIPv4(embedded(g[1]!, g[2]!)); // 6to4
  if (g[0] === 0x2001 && g[1] === 0) return true; // Teredo
  if (g[0] === 0x2001 && g[1] === 0xdb8) return true; // documentation
  if (g[0] === 0x100 && g[1] === 0 && g[2] === 0 && g[3] === 0) return true; // discard-only
  if ((g[0]! & 0xfe00) === 0xfc00) return true; // unique local
  if ((g[0]! & 0xffc0) === 0xfe80) return true; // link-local
  if ((g[0]! & 0xffc0) === 0xfec0) return true; // site-local
  if ((g[0]! & 0xff00) === 0xff00) return true; // multicast
  return false;
}

/** Whether a URL may be fetched at all, before any DNS lookup. WHATWG parsing has already turned decimal, hex, octal and short IPv4 forms into dotted ones. */
export function checkFetchUrl(raw: string): UrlCheck {
  if (raw.length > MAX_URL_CHARS) return { ok: false, reason: "URL too long" };
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: "invalid URL" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return { ok: false, reason: `scheme ${url.protocol} not allowed` };
  if (url.username || url.password) return { ok: false, reason: "URL carries credentials" };
  if (!ALLOWED_PORTS.has(url.port)) return { ok: false, reason: `port ${url.port} not allowed` };
  const host = url.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
  if (isIP(host) !== 0) return isBlockedAddress(host) ? { ok: false, reason: `address ${host} is not public` } : { ok: true, url };
  if (!host.includes(".") || host === "localhost" || INTERNAL_SUFFIXES.some((s) => host.endsWith(s))) return { ok: false, reason: `host ${host} is internal` };
  return { ok: true, url };
}
