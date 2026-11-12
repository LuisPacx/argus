// The home page's compact research bar: the /api/research payload as short figures, bar widths, inline alerts and the long details.
// Pure, so the numbers are unit-tested without the page. Text only.
import { proposalCapText } from "./proposal-sort.ts";

export interface ResearchPayload {
  usedUsd: number;
  budgetUsd: number;
  runs: number;
  usedShareOfQuota: number;
  quotaUsd: number;
  share: number;
  exhausted: boolean;
  newProposals: number;
  newProposalsCap: number;
  api: { enabled: boolean; capUsd: number; usedUsd: number; runs: number; exhausted: boolean };
}

export interface ResearchBarView {
  label: string;
  budget: string;
  budgetPct: number;
  budgetExhausted: boolean;
  proposals: string;
  proposalsPct: number;
  api: string;
  alerts: string[];
  details: string[];
}

const pct = (used: number, of: number): number => (of > 0 ? Math.min(100, Math.max(0, (used / of) * 100)) : 0);
const runs = (n: number) => `${n} ${n === 1 ? "run" : "runs"}`;

export function researchBar(r: ResearchPayload): ResearchBarView {
  const alerts: string[] = [];
  if (r.exhausted) alerts.push("Research budget reached: judging and proposing wait until older runs leave the 24 hours.");
  if (r.newProposals >= r.newProposalsCap) alerts.push("Proposal cap reached; the next waits until an older Proposal is more than 24 h old.");
  if (r.api.exhausted) alerts.push("API daily cap reached: the fallback sends nothing until older spend leaves the 24 hours.");
  const details = [
    "Budget is Est. usage, API-equivalent as reported by claude -p. Runs use the Claude subscription; this is not a charge.",
    `${r.runs} judge and propose ${r.runs === 1 ? "run" : "runs"}, ${Math.round(r.usedShareOfQuota * 100)}% of an assumed $${r.quotaUsd.toFixed(0)} daily quota; the limit is ${Math.round(r.share * 100)}%.`,
    `New Proposals: ${proposalCapText(r.newProposals, r.newProposalsCap)}.`,
    `API spend is real money billed by the Anthropic API, unlike Est. usage. Only the API fallback spends it, when the subscription is rate-limited: $${r.api.usedUsd.toFixed(4)} of $${r.api.capUsd.toFixed(2)} daily cap over ${runs(r.api.runs)}.`,
  ];
  if (!r.api.enabled) details.push("API fallback is off: set ARGUS_API_FALLBACK=1 and ANTHROPIC_API_KEY in .env to turn it on.");
  return {
    label: "Research 24h",
    budget: `$${r.usedUsd.toFixed(2)} / $${r.budgetUsd.toFixed(2)}`,
    budgetPct: pct(r.usedUsd, r.budgetUsd),
    budgetExhausted: r.exhausted,
    proposals: `${r.newProposals} / ${r.newProposalsCap}`,
    proposalsPct: pct(r.newProposals, r.newProposalsCap),
    api: `API $${r.api.usedUsd.toFixed(4)} / $${r.api.capUsd.toFixed(2)}`,
    alerts,
    details,
  };
}
