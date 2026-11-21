import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { hostname } from "node:os";
import { checkFetchUrl, isBlockedAddress } from "../study/ssrf.ts";

/**
 * What a run that reads the open web may fetch (human researcher ticket 12, ADR 0017, ADR 0009). A prompt-injected page or a hostile topic could steer
 * the model's WebFetch tool at this machine's own network (the War Room, the worker, a router page, a cloud metadata address). The rule is enforced in
 * the model command, not in the prompt, in two layers that `ClaudeCodeBrain.buildArgs` adds to every task whose tools include WebFetch:
 *
 *  1. `--disallowedTools "WebFetch(domain:...)"`: the CLI's own deny rules (deny beats allow). The CLI matches a hostname, exactly or with a `*.` prefix,
 *     and nothing else: no address range, no numeric form, no resolved address. So this layer only names the literal local hosts.
 *  2. A PreToolUse hook on WebFetch (`--settings`): `fetch-guard-hook.ts` reads the tool call, and `checkResearchUrl` refuses it unless the URL is plain
 *     http(s) on a default port with no credentials, names no loopback, private, link-local, reserved or internal address (the numeric, bracketed and
 *     IPv4-mapped spellings are normalised by the WHATWG URL parser first), is not this machine's own host, and, for a hostname, resolves only to public
 *     addresses. A name that does not resolve, a lookup that times out and any crash are refusals (the hook command ends `|| exit 2`).
 *
 * Limits, stated plainly: the check resolves a name when WebFetch asks, and WebFetch resolves it again when it connects, so a DNS answer that changes
 * between the two (rebinding) is not caught; a redirect to another host is a new WebFetch call, which passes through the hook again.
 */

/** The hostnames the CLI deny rules name. Literal hosts only: the CLI cannot match a range. */
export const DENIED_FETCH_DOMAINS: readonly string[] = ["localhost", "*.localhost", "127.0.0.1", "0.0.0.0", "169.254.169.254", "metadata.google.internal", "*.local", "*.internal"];

const LOOKUP_MS = 5_000;
const NAME_RE = /^[a-z0-9.-]{1,253}$/;

/** The names this machine goes by, which the War Room (and the worker) answer on besides loopback. */
export function ownHostNames(): string[] {
  const h = hostname().toLowerCase();
  const out = new Set<string>(["localhost"]);
  if (NAME_RE.test(h)) {
    out.add(h);
    out.add(h.split(".")[0]!);
  }
  return [...out];
}

/** The `--disallowedTools` value: the CLI deny rule of each local host, this machine's own names included. */
export function fetchDenyRules(own: readonly string[] = ownHostNames()): string[] {
  const names = new Set([...DENIED_FETCH_DOMAINS, ...own.filter((n) => NAME_RE.test(n))]);
  return [...names].map((d) => `WebFetch(domain:${d})`);
}

export type FetchVerdict = { allow: true } | { allow: false; reason: string };

export interface FetchGuardDeps {
  /** Every address a name resolves to. Injected in tests; the real one is `dns.lookup(all)`. */
  resolve: (host: string) => Promise<string[]>;
  /** Hostnames of this machine, compared without a trailing dot, lower case. */
  own: readonly string[];
}

/** The real resolver, cut short: a lookup that takes too long is a refusal, never a wait. */
export async function resolveAll(host: string): Promise<string[]> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const answer = await Promise.race([
      lookup(host, { all: true, verbatim: true }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("lookup timed out")), LOOKUP_MS);
      }),
    ]);
    return answer.map((a) => a.address);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Whether a research run may fetch `raw`. Public addresses and hostnames that resolve only to public addresses pass; everything else is refused with a
 * reason. A value with no scheme is judged as the https address it would be read as, so `localhost:3100/x` is not a way round the scheme test.
 */
export async function checkResearchUrl(raw: unknown, deps: FetchGuardDeps = { resolve: resolveAll, own: ownHostNames() }): Promise<FetchVerdict> {
  if (typeof raw !== "string" || raw.trim() === "") return { allow: false, reason: "no URL" };
  const text = raw.trim();
  const checked = checkFetchUrl(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : ["https", text].join("://"));
  if (!checked.ok) return { allow: false, reason: checked.reason };
  const host = checked.url.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
  if (deps.own.some((n) => n.toLowerCase().replace(/\.$/, "") === host)) return { allow: false, reason: `host ${host} is this machine` };
  if (isIP(host) !== 0) return { allow: true }; // an address literal: `checkFetchUrl` has already refused every non-public one
  let addresses: string[];
  try {
    addresses = await deps.resolve(host);
  } catch {
    return { allow: false, reason: `host ${host} did not resolve` };
  }
  if (addresses.length === 0) return { allow: false, reason: `host ${host} did not resolve` };
  const bad = addresses.find((a) => isBlockedAddress(a));
  if (bad !== undefined) return { allow: false, reason: `host ${host} resolves to ${bad}, which is not public` };
  return { allow: true };
}

/**
 * The hook's decision from the text the CLI writes on its stdin (`{"tool_name":"WebFetch","tool_input":{"url":...}}`). Anything it cannot read is a
 * refusal: for the one tool the hook is installed on, a call it cannot judge is not let through.
 */
export async function decideHook(stdin: string, deps?: FetchGuardDeps): Promise<FetchVerdict> {
  let input: unknown;
  try {
    input = JSON.parse(stdin);
  } catch {
    return { allow: false, reason: "the tool call could not be read" };
  }
  const call = input as { tool_name?: unknown; tool_input?: { url?: unknown } } | null;
  if (call === null || typeof call !== "object") return { allow: false, reason: "the tool call could not be read" };
  if (call.tool_name !== "WebFetch") return { allow: false, reason: "this guard judges WebFetch only" };
  return checkResearchUrl(call.tool_input?.url, deps);
}

/** What the model is told when a fetch is refused. Never the address that was probed beyond what the URL already said. */
export const refusalText = (reason: string): string => `Argus refused this fetch: ${reason}. A research run reads public web pages only (no localhost, private network, link-local address or this machine).`;

/** A path or program name that is safe inside the hook's single-quoted shell command. */
const quoted = (s: string): string => {
  if (s.includes("'") || s.includes("\n") || s.includes("\0")) throw new Error(`cannot quote ${JSON.stringify(s)} for the hook command`);
  return `'${s}'`;
};

/**
 * The `--settings` JSON that installs the hook on WebFetch. The command ends `|| exit 2`: the CLI lets a call through when a hook crashes or cannot
 * start (any exit code but 2 is a non-blocking error), so a failed start must end in 2, and only an explicit exit 0 from the script allows the fetch.
 */
export function fetchGuardSettings(nodePath: string, hookScript: string): string {
  const command = `${quoted(nodePath)} ${quoted(hookScript)} || exit 2`;
  return JSON.stringify({ hooks: { PreToolUse: [{ matcher: "WebFetch", hooks: [{ type: "command", command, timeout: 20 }] }] } });
}
