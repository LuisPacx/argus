import { cleanLink, cleanText, isRecord } from "../sources/untrusted-text.ts";
import { metadataCandidates, type GatewayStats } from "./ipfs-gateways.ts";
import { guardedGet, type Resolver, type Transport } from "./guarded-fetch.ts";

/**
 * A token's metadata document: the JSON at the `uri` of its PumpPortal create event. The payload itself carries no links; the website,
 * X and Telegram links are in this document, so the population rule reads it. It is untrusted and fetched through the SSRF guard.
 */

const DESCRIPTION_CHARS = 1_000;

export interface TokenMetadata {
  description: string;
  imageUrl: string | null;
  websiteUrl: string | null;
  xUrl: string | null;
  telegramUrl: string | null;
}

const X_HOSTS = /^(?:www\.|mobile\.)?(?:x|twitter)\.com$/i;
const TELEGRAM_HOSTS = /^(?:www\.)?(?:t\.me|telegram\.me|telegram\.org)$/i;

type LinkKind = "website" | "x" | "telegram";

/** What a creator-supplied link points at, by host, and its normal form. A bare x.com with no path is not a link to anything. */
function classify(raw: unknown): { kind: LinkKind; url: string } | undefined {
  const link = cleanLink(raw);
  if (!link) return undefined;
  let u: URL;
  try {
    u = new URL(link);
  } catch {
    return undefined;
  }
  if (X_HOSTS.test(u.hostname)) return u.pathname.length > 1 ? { kind: "x", url: `https://x.com${u.pathname}` } : undefined;
  if (TELEGRAM_HOSTS.test(u.hostname)) return { kind: "telegram", url: `https://${u.hostname.replace(/^www\./, "")}${u.pathname}` };
  return { kind: "website", url: u.href };
}

/** Reads the metadata document; undefined when it is not a JSON object. Only the first link of each kind is kept (one website URL only). */
export function parseMetadata(text: string): TokenMetadata | undefined {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isRecord(doc)) return undefined;
  const found: Partial<Record<LinkKind, string>> = {};
  for (const field of ["website", "twitter", "telegram", "external_url"]) {
    const c = classify(doc[field]);
    if (c && found[c.kind] === undefined) found[c.kind] = c.url;
  }
  return {
    description: cleanText(doc.description, DESCRIPTION_CHARS),
    imageUrl: cleanLink(doc.image) || null,
    websiteUrl: found.website ?? null,
    xUrl: found.x ?? null,
    telegramUrl: found.telegram ?? null,
  };
}

/** The population rule (spec section 5): a website or an X link means studied; neither means counted for the base rate and not studied. */
export function inPopulation(m: TokenMetadata): { studied: boolean; reason: string } {
  if (m.websiteUrl && m.xUrl) return { studied: true, reason: "population: website and X links" };
  if (m.websiteUrl) return { studied: true, reason: "population: website link" };
  if (m.xUrl) return { studied: true, reason: "population: X link" };
  return { studied: false, reason: "no website or X link" };
}

/** A failure is `retryable` when asking again could help (a timeout, a network error, a 5xx or 429); a refused address or a bad document will not change. */
export type MetadataFetch = { ok: true; metadata: TokenMetadata } | { ok: false; detail: string; retryable: boolean };

export interface MetadataFetchOptions {
  maxBytes: number;
  timeoutMs: number;
  resolve?: Resolver;
  transport?: Transport;
  /** Ordered IPFS gateway base URLs; an IPFS uri is tried on each in turn. Default: `DEFAULT_IPFS_GATEWAYS`. */
  gateways?: readonly string[];
  /** Counts each gateway request as ok or failed. */
  stats?: GatewayStats;
}

/**
 * A guarded GET of the uri. An IPFS uri (ipfs:// or on a public gateway such as ipfs.io) is fetched from the configured gateways in
 * order; a retryable failure (429, 5xx, timeout, network error) moves on to the next gateway. Never throws.
 */
export async function fetchMetadata(uri: string, opts: MetadataFetchOptions): Promise<MetadataFetch> {
  const urls = metadataCandidates(uri, opts.gateways);
  let last: MetadataFetch = { ok: false, detail: "no gateway", retryable: false };
  let anyRetryable = false;
  for (const url of urls) {
    last = await fetchOne(url, opts);
    if (urls.length > 1) opts.stats?.record(hostOf(url), last.ok);
    if (last.ok) return last;
    anyRetryable ||= last.retryable;
    if (!last.retryable) break;
  }
  return last.ok ? last : { ...last, retryable: anyRetryable };
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "?";
  }
}

async function fetchOne(uri: string, opts: MetadataFetchOptions): Promise<MetadataFetch> {
  const r = await guardedGet(uri, { ...opts, headers: { accept: "application/json,*/*;q=0.1" } });
  if (!r.ok) return { ok: false, detail: `${r.reason}: ${r.detail}`.replace(/[?#]\S*/g, "").slice(0, 200), retryable: r.reason === "timeout" || r.reason === "error" };
  if (r.status < 200 || r.status >= 300) return { ok: false, detail: `HTTP ${r.status}`, retryable: r.status >= 500 || r.status === 429 };
  if (r.truncated) return { ok: false, detail: `metadata over ${opts.maxBytes} bytes`, retryable: false };
  const metadata = parseMetadata(r.body.toString("utf8"));
  return metadata ? { ok: true, metadata } : { ok: false, detail: "not a JSON object", retryable: false };
}
