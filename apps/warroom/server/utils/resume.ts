import { resolve } from "node:path";
import { buildHomeFor, resumeCommand, type Proposal } from "@argus/core";

/**
 * A Proposal as the War Room shows it: for a `build-failed` Build with a recorded session, the exact command to continue that
 * session in tmux on the host (the session lives in the per-Build home, not in `~/.claude`); null otherwise.
 */
export function withResume(p: Proposal, dataDir: string, buildRoot: string): Proposal & { resumeCommand: string | null } {
  if (p.status !== "build-failed" || !p.buildSessionId) return { ...p, resumeCommand: null };
  try {
    return { ...p, resumeCommand: resumeCommand({ repo: resolve(buildRoot, p.slug), home: buildHomeFor(dataDir, p.id), sessionId: p.buildSessionId }) };
  } catch {
    // a stored session id that is not one: no command rather than a wrong one
    return { ...p, resumeCommand: null };
  }
}
