interface ScoreLike {
  total: number;
  scores: Record<string, number>;
}

/**
 * The "now: ..." line under a Proposal's Score: the Narrative's latest Score as the Score the Proposal was created from differs from it.
 * The total (when it shows differently at one decimal) and each dimension that changed, e.g. "now: 6.1/10, buildability 4". Null when
 * there is no newer Score or nothing the reader would see differs.
 */
export function scoreNowLine(created: ScoreLike | null, latest: ScoreLike | null | undefined): string | null {
  if (!created || !latest) return null;
  const parts: string[] = [];
  if (latest.total.toFixed(1) !== created.total.toFixed(1)) parts.push(`${latest.total.toFixed(1)}/10`);
  for (const [key, value] of Object.entries(latest.scores)) {
    if (created.scores[key] !== value) parts.push(`${key} ${value}`);
  }
  return parts.length === 0 ? null : `now: ${parts.join(", ")}`;
}
