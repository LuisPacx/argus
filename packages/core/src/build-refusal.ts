/**
 * Why a Build was not started: the preflight's typed refusal, stored per approved Proposal so the War Room can show it.
 * The message is plain text that may name a path, an image tag or a variable NAME; it never holds a secret or a byte of the Build token file.
 */

/** How often the worker tries to start a Build; the Proposal page says "retried every N s" from this one value. */
export const BUILD_TICK_MS = 5_000;

export const BUILD_REFUSAL_CODES = [
  "podman-missing",
  "image-missing",
  "network-missing",
  "token-missing",
  "token-not-file",
  "token-mode",
  "token-empty",
  "token-multiline",
  "cloudflare-creds-missing",
  "dry-run",
] as const;

export type BuildRefusalCode = (typeof BUILD_REFUSAL_CODES)[number];

/** What the preflight answers when a Build cannot start. */
export interface PreflightRefusal {
  code: BuildRefusalCode;
  message: string;
}

/** What the Proposal API carries for an approved Proposal whose Build was refused (null otherwise). */
export interface BuildRefusal extends PreflightRefusal {
  /** UTC ISO time of the latest refused attempt. */
  at: string;
}

const CLOUDFLARE_VARIABLES = ["CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_API_TOKEN"] as const;

/** The variable names a Build needs from `env` and does not find (unset or empty). Names only, never a value. */
export function missingCloudflareVariables(env: Record<string, string | undefined>): string[] {
  return CLOUDFLARE_VARIABLES.filter((name) => !env[name]);
}

/** A Cloudflare refusal naming the missing variable names, or undefined when both are set. The Build reads the same `env`. */
export function cloudflareRefusal(env: Record<string, string | undefined>): PreflightRefusal | undefined {
  const missing = missingCloudflareVariables(env);
  if (missing.length === 0) return undefined;
  return { code: "cloudflare-creds-missing", message: `${missing.join(" and ")} ${missing.length === 1 ? "is" : "are"} not set; the Build needs them to check that the Worker name is free` };
}
