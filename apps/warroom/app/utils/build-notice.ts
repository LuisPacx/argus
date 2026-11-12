// What an approved Proposal says about its Build, from the Proposal API's own fields. The refusal message holds a filesystem path, an
// image tag or a variable name; the component draws it as text only (no raw-HTML directive).

/** The part of GET /api/proposals/:id this reads (the server's `ProposalBuildStatus` plus `status`; the server test types the response with it). */
export interface BuildNoticeInput {
  status: string;
  buildRefusal: { code: string; message: string; at: string } | null;
  buildRunning: boolean;
  buildRetrySeconds: number;
}

export interface BuildNoticeView {
  kind: "refused" | "running" | "waiting";
  text: string;
  /** "last checked 12 s ago", only for a refusal. */
  checked: string | null;
}

/** "12 s ago", "3 min ago", "2 h ago". */
function checkedAge(iso: string, nowMs: number): string {
  const s = Math.max(0, Math.round((nowMs - Date.parse(iso)) / 1000));
  if (!Number.isFinite(s)) return "";
  if (s < 60) return `${s} s ago`;
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  return `${Math.floor(s / 3600)} h ago`;
}

/** The notice for an approved Proposal, or null for any other status. */
export function buildNoticeView(p: BuildNoticeInput, nowMs: number): BuildNoticeView | null {
  if (p.status !== "approved") return null;
  if (p.buildRefusal) {
    const age = checkedAge(p.buildRefusal.at, nowMs);
    return { kind: "refused", text: `Build not started: ${p.buildRefusal.message}, retried every ${p.buildRetrySeconds} s`, checked: age ? `last checked ${age}` : null };
  }
  if (p.buildRunning) return { kind: "running", text: "Waiting for the running Build to finish", checked: null };
  return { kind: "waiting", text: "Waiting for the next build tick", checked: null };
}
