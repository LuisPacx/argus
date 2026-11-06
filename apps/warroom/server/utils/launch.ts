import { buildLaunchLink, type Proposal } from "@argus/core";

/**
 * The Launch link for a Proposal: only a `built` one has one (Launch is enabled only then). It opens newpairspam's Deploy form
 * prefilled; argus makes no call to newpairspam or a chain (ADR 0002). Base URL: ARGUS_NEWPAIRSPAM_URL, default http://localhost:3000.
 */
export function launchLinkFor(p: Proposal, env: Record<string, string | undefined> = process.env, log: (line: string) => void = console.error): string | null {
  if (p.status !== "built") return null;
  const link = buildLaunchLink(p, { baseUrl: env.ARGUS_NEWPAIRSPAM_URL, logoUrl: env.ARGUS_LAUNCH_LOGO_URL });
  // A bad base URL is a config error: say so once, show no Launch link, never throw (a 500) or hand the page a `javascript:` href.
  if (link === null && warnedBase !== env.ARGUS_NEWPAIRSPAM_URL) {
    warnedBase = env.ARGUS_NEWPAIRSPAM_URL;
    log(`[warroom] ARGUS_NEWPAIRSPAM_URL is not an http(s) URL; the Launch link is disabled`);
  }
  return link;
}

let warnedBase: string | undefined;
