export function registryDirFor(guardPid: number): string;
export function startTicks(pid: number): number | undefined;
export function registerPid(pid: number | undefined): void;
export function registerFake(): void;
export function recordGuard(dir: string, tmpRoot: string): void;
export function makeWritable(path: string): void;
export function removeTree(path: string): void;
export interface ReapedRun {
  dir: string;
  mtimeMs: number;
  /** Wall-clock start of the run's guard, and its ancestor pids; undefined / empty for an older-format registry. */
  startedMs: number | undefined;
  ancestors: number[];
  killed: number[];
  root: string | undefined;
}
export function reapDeadRuns(registryRoot?: string): ReapedRun[];
