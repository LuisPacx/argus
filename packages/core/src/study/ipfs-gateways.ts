/**
 * IPFS gateway handling for the metadata fetch. Almost every PumpPortal `uri` is `https://ipfs.io/ipfs/<cid>`, and ipfs.io answers most
 * of our requests with HTTP 429 (measured 2026-11-11: 76% of ipfs.io uris failed, other gateways 0%). A uri on a public gateway is
 * rewritten to the ordered list below; the capture job tries them in turn. The gateways are plain https base URLs, read-only GETs through
 * the SSRF guard, like any other creator-supplied uri.
 */

/** Tried in this order. Chosen from a live probe on 2026-11-11: fast and unthrottled first, the slow one (about 6 s) last. */
export const DEFAULT_IPFS_GATEWAYS: readonly string[] = [
  "https://4everland.io/ipfs/",
  "https://ipfs.filebase.io/ipfs/",
  "https://gw.ipfs-lens.dev/ipfs/",
  "https://gateway.pinata.cloud/ipfs/",
];

/** Public gateways whose uris get rewritten (a creator's uri on one of these is just "this CID"). Any other host is fetched as given. */
const PUBLIC_GATEWAY_HOSTS = new Set([
  "ipfs.io",
  "dweb.link",
  "w3s.link",
  "nftstorage.link",
  "cloudflare-ipfs.com",
  "cf-ipfs.com",
  "gateway.pinata.cloud",
  "gateway.ipfs.io",
  "4everland.io",
  "ipfs.filebase.io",
  "gw.ipfs-lens.dev",
]);

const CID = /^[A-Za-z0-9]{46,100}$/;

/** The gateways in force: `ARGUS_STUDY_IPFS_GATEWAYS` (comma-separated https base URLs, ordered) or the default; junk entries are dropped. */
export function ipfsGateways(env: Record<string, string | undefined> = process.env): string[] {
  const raw = env.ARGUS_STUDY_IPFS_GATEWAYS;
  if (!raw) return [...DEFAULT_IPFS_GATEWAYS];
  const out: string[] = [];
  for (const part of raw.split(",")) {
    let u: URL;
    try {
      u = new URL(part.trim());
    } catch {
      continue;
    }
    if (u.protocol !== "https:" || u.username || u.password || u.search || u.hash) continue;
    out.push(`${u.origin}${u.pathname.replace(/\/*$/, "")}/`);
  }
  return out.length > 0 ? out : [...DEFAULT_IPFS_GATEWAYS];
}

/** The CID and the rest (path and query) when `uri` names IPFS content on ipfs:// or a public gateway; undefined otherwise. */
export function parseIpfsUri(uri: string, gateways: readonly string[] = DEFAULT_IPFS_GATEWAYS): { cid: string; rest: string } | undefined {
  let u: URL;
  try {
    u = new URL(uri);
  } catch {
    return undefined;
  }
  const known = new Set(PUBLIC_GATEWAY_HOSTS);
  for (const g of gateways) known.add(new URL(g).hostname);
  let cid: string | undefined;
  let path: string;
  if (u.protocol === "ipfs:") {
    // ipfs://<cid>/rest parses with the cid as the host (lower-cased); ipfs://ipfs/<cid> is the old form.
    const segs = `${u.hostname}${u.pathname}`.split("/").filter(Boolean);
    if (segs[0] === "ipfs") segs.shift();
    cid = segs.shift();
    path = segs.length > 0 ? `/${segs.join("/")}` : "";
  } else if (u.protocol === "https:" || u.protocol === "http:") {
    const sub = /^([a-z0-9]+)\.ipfs\.(.+)$/i.exec(u.hostname);
    if (sub && known.has(sub[2]!.toLowerCase())) {
      cid = sub[1];
      path = u.pathname === "/" ? "" : u.pathname;
    } else if (known.has(u.hostname.toLowerCase()) && u.pathname.startsWith("/ipfs/")) {
      const segs = u.pathname.slice("/ipfs/".length).split("/");
      cid = segs.shift();
      path = segs.length > 0 && segs.join("") !== "" ? `/${segs.join("/")}` : "";
    } else return undefined;
  } else return undefined;
  if (!cid || !CID.test(cid)) return undefined;
  return { cid, rest: `${path}${u.protocol === "ipfs:" ? "" : u.search}` };
}

/** The urls to try, in order: every configured gateway for an IPFS uri, otherwise the uri as given. */
export function metadataCandidates(uri: string, gateways: readonly string[] = DEFAULT_IPFS_GATEWAYS): string[] {
  const ipfs = gateways.length > 0 ? parseIpfsUri(uri, gateways) : undefined;
  if (!ipfs) return [uri];
  return gateways.map((g) => `${g}${ipfs.cid}${ipfs.rest}`);
}

/** Per-gateway counts of fetches that worked and that failed, for the log. */
export class GatewayStats {
  private readonly counts = new Map<string, { ok: number; fail: number }>();

  record(host: string, ok: boolean): void {
    const c = this.counts.get(host) ?? { ok: 0, fail: 0 };
    if (ok) c.ok++;
    else c.fail++;
    this.counts.set(host, c);
  }

  /** `host ok/fail` pairs, or undefined when nothing was fetched. */
  summary(): string | undefined {
    if (this.counts.size === 0) return undefined;
    return [...this.counts].map(([h, c]) => `${h} ok=${c.ok} fail=${c.fail}`).join(", ");
  }
}
