/**
 * The automatic research tick (judge, then propose) as a schedule that ADR 0017 switched off by default: Claude runs only when the Operator
 * triggers it. Off, no timer exists and `run` is never called, so no judge or propose run can start; on (ARGUS_RESEARCH_TICK=1), it runs once now
 * and then every `intervalMs`, with the judge and propose caps unchanged. Returns the timer so the worker can clear it on stop.
 */
export function startResearchSchedule(opts: { enabled: boolean; intervalMs: number; run: () => Promise<void>; log: (line: string) => void }): ReturnType<typeof setInterval> | undefined {
  if (!opts.enabled) {
    opts.log("[worker] research tick off (ADR 0017: Claude runs only when the Operator triggers it; ARGUS_RESEARCH_TICK=1 turns the automatic judge and propose back on)");
    return undefined;
  }
  void opts.run();
  return setInterval(() => void opts.run(), opts.intervalMs);
}
