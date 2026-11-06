/**
 * The Launch handoff (ADR 0002). argus only builds a link that opens newpairspam's Deploy form prefilled; the Operator launches there
 * and comes back to record the mint. Nothing here touches a wallet or a chain.
 */

/** Solana addresses are base58, 32 to 44 characters. Only the format is checked; argus never asks a chain whether the mint exists. */
const MINT_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export function isMintAddress(s: unknown): s is string {
  return typeof s === "string" && MINT_RE.test(s);
}

/** newpairspam's `nuxt dev` default port; override with ARGUS_NEWPAIRSPAM_URL. */
export const DEFAULT_NEWPAIRSPAM_URL = "http://localhost:3000";

/** Form limits in newpairspam's TokenForm (name 32, ticker 10); it clamps again on its side. */
const NAME_MAX = 32;
const TICKER_MAX = 10;

export interface LaunchLinkInput {
  name: string;
  ticker: string;
  description: string;
  /** The workers.dev preview of the Build, sent as the token's website. */
  previewUrl: string | null;
}

export interface LaunchLinkOptions {
  /** newpairspam's base URL. Empty or unset means the default. */
  baseUrl?: string;
  /** Public http(s) URL of the logo, when one is hosted. newpairspam's image proxy rejects SVG, so none is sent by default. */
  logoUrl?: string;
}

/** The base as an http(s) URL, the default when empty or unset, null when it is anything else (`javascript:`, garbage). */
export function parseNewpairspamBase(raw: string | undefined): URL | null {
  try {
    const url = new URL(raw?.trim() || DEFAULT_NEWPAIRSPAM_URL);
    return url.protocol === "http:" || url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

/**
 * `<base>/?name=&symbol=&description=&website=[&imageUrl=]`, the contract of newpairspam's `parseLaunchPrefill`.
 * Null when the base URL is not http(s): the caller shows no Launch link rather than a bad href.
 */
export function buildLaunchLink(p: LaunchLinkInput, opts: LaunchLinkOptions = {}): string | null {
  const url = parseNewpairspamBase(opts.baseUrl);
  if (!url) return null;
  url.pathname = "/";
  url.search = "";
  const q = url.searchParams;
  q.set("name", p.name.slice(0, NAME_MAX));
  q.set("symbol", p.ticker.slice(0, TICKER_MAX));
  if (p.description) q.set("description", p.description);
  if (p.previewUrl) q.set("website", p.previewUrl);
  if (opts.logoUrl && /^https?:\/\//i.test(opts.logoUrl)) q.set("imageUrl", opts.logoUrl);
  return url.toString();
}
