import { bareUrl, fmtWhen } from "./format.ts";
import { safeHttpUrl } from "./safe-link.ts";

export interface WhySignal {
  title: string;
  sourceLabel: string;
  url: string | null;
  publishedAt: string;
}

export interface WhyInput {
  reason: string;
  interaction: string;
  evidenceLinks: string[];
  signals: WhySignal[];
  score: { scores: Record<string, number>; rationale: string; rubricVersion: number } | null;
}

/** What the "Why this Proposal" panel renders. Every string is untrusted text; every `href` is http(s) or null. */
export interface WhyView {
  reason: string | null;
  interaction: string | null;
  signals: Array<{ title: string; source: string; href: string | null; when: string }>;
  score: { scores: Record<string, number>; rationale: string | null; rubricVersion: number } | null;
  evidence: Array<{ text: string; href: string | null }>;
}

/** Empty or blank text (old Proposals store "") becomes null, so the panel shows it as absent. */
const present = (s: string | null | undefined): string | null => (s && s.trim() !== "" ? s : null);

export function whyView(p: WhyInput): WhyView {
  return {
    reason: present(p.reason),
    interaction: present(p.interaction),
    signals: p.signals.map((s) => ({ title: s.title, source: s.sourceLabel, href: safeHttpUrl(s.url), when: fmtWhen(s.publishedAt) })),
    score: p.score ? { scores: p.score.scores, rationale: present(p.score.rationale), rubricVersion: p.score.rubricVersion } : null,
    evidence: p.evidenceLinks.map((l) => {
      const href = safeHttpUrl(l);
      return { text: href ? bareUrl(href) : l, href };
    }),
  };
}
