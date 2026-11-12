import { runNextBuild } from "../build-runner.ts";
import type { Harness } from "./build-harness.ts";

export const flagValues = (argv: string[], flag: string) => argv.flatMap((a, i) => (a === flag ? [argv[i + 1]!] : []));

/** Runs one Build and returns the Proposal after, its last status reason, and what the fake wrangler saw. */
export async function build(h: Harness) {
  const p = h.seedApproved("Cat Coin");
  const outcome = await runNextBuild(h.store, h.brain, h.options);
  const after = h.store.getProposal(p.id)!;
  const reason = h.store.historyFor(p.id).at(-1)!.reason;
  const calls = h.calls(h.wranglerLog);
  const flag = (c: Record<string, any>, name: string) => c.argv[c.argv.indexOf(name) + 1] as string;
  return {
    p,
    outcome,
    after,
    reason,
    calls,
    flag,
    bundle: calls.filter((c) => c.argv.includes("--dry-run")),
    deploys: calls.filter((c) => !c.argv.includes("--dry-run")),
  };
}
