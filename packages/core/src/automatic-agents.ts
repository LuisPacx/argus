// ADR 0017: Claude runs only when the Operator triggers it. These are the automatic agents that were switched off, as switches: nothing is
// deleted, and each one turns back on with its own variable and its existing caps. The haiku tasks (meta-group, meta-summary, radar-name)
// and the plain-code jobs are not here: they stay on.

export interface AutomaticAgent {
  id: "research-tick" | "meta-meme-ideas" | "moment-scanner";
  label: string;
  /** The variable that turns it back on. */
  switch: string;
  on: boolean;
}

/**
 * ARGUS_RESEARCH_TICK: `1` turns the automatic research tick (judge, then propose, every 30 minutes) back on; unset, empty or `0` leave it
 * off (the default); anything else is an error, as for ARGUS_MEME_IDEAS.
 */
export function researchTickEnabled(env: Record<string, string | undefined>): boolean {
  const raw = env.ARGUS_RESEARCH_TICK?.trim() ?? "";
  if (raw !== "" && raw !== "0" && raw !== "1") throw new Error(`ARGUS_RESEARCH_TICK must be 1 (on) or 0 or unset (off), got "${env.ARGUS_RESEARCH_TICK}"`);
  return raw === "1";
}

/** The three automatic agents ADR 0017 switched off, each with its state in this environment. Meme ideas and the scanner keep their own switches. */
export function automaticAgents(env: Record<string, string | undefined>): AutomaticAgent[] {
  const memeRaw = env.ARGUS_MEME_IDEAS?.trim() ?? "";
  if (memeRaw !== "" && memeRaw !== "0" && memeRaw !== "1") throw new Error(`ARGUS_MEME_IDEAS must be 1 (on) or 0 or unset (off), got "${env.ARGUS_MEME_IDEAS}"`);
  return [
    { id: "research-tick", label: "Research tick (judge and propose)", switch: "ARGUS_RESEARCH_TICK", on: researchTickEnabled(env) },
    { id: "meta-meme-ideas", label: "Meta meme ideas", switch: "ARGUS_MEME_IDEAS", on: memeRaw === "1" },
    { id: "moment-scanner", label: "Moment scanner", switch: "ARGUS_MOMENTS", on: env.ARGUS_MOMENTS === "1" },
  ];
}

/** The one line the worker writes at start, and the War Room shows: which automatic agents are off. */
export function automaticAgentsLine(agents: AutomaticAgent[]): string {
  const off = agents.filter((a) => !a.on);
  if (off.length === 0) return "Automatic agents: all on (ADR 0017: Claude runs only when the Operator triggers it, unless a switch says otherwise)";
  return `Automatic agents off (ADR 0017, Claude runs only when the Operator triggers it): ${off.map((a) => `${a.label} (${a.switch}=1 turns it on)`).join("; ")}`;
}
