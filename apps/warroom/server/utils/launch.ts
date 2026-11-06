import { buildLaunchLink, type Proposal } from "@argus/core";

/**
 * The Launch link for a Proposal: only a `built` one has one (Launch is enabled only then). It opens newpairspam's Deploy form
 * prefilled; argus makes no call to newpairspam or a chain (ADR 0002). Base URL: ARGUS_NEWPAIRSPAM_URL, default http://localhost:3000.
 */
export function launchLinkFor(p: Proposal, env: Record<string, string | undefined> = process.env): string | null {
  if (p.status !== "built") return null;
  return buildLaunchLink(p, { baseUrl: env.ARGUS_NEWPAIRSPAM_URL, logoUrl: env.ARGUS_LAUNCH_LOGO_URL });
}
