/**
 * Small interval helpers for the Beta backtest (viral sources ticket 04, slice 5). Plain arithmetic, no I/O.
 */

export interface Interval {
  low: number;
  high: number;
}

const Z95 = 1.959964;

/** Wilson score interval for k successes in n trials (95%). With n = 0 it is [0, 1]: nothing is known. */
export function wilson(k: number, n: number, z = Z95): Interval {
  if (n <= 0) return { low: 0, high: 1 };
  const p = k / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return { low: Math.max(0, centre - half), high: Math.min(1, centre + half) };
}

/** Newcombe's hybrid-score interval for the difference p1 - p2 of two independent proportions (95%). */
export function newcombeDiff(k1: number, n1: number, k2: number, n2: number): Interval {
  const p1 = n1 > 0 ? k1 / n1 : 0;
  const p2 = n2 > 0 ? k2 / n2 : 0;
  const a = wilson(k1, n1);
  const b = wilson(k2, n2);
  const d = p1 - p2;
  return { low: d - Math.sqrt((p1 - a.low) ** 2 + (b.high - p2) ** 2), high: d + Math.sqrt((a.high - p1) ** 2 + (p2 - b.low) ** 2) };
}

/** A small seeded generator (mulberry32), so a bootstrap gives the same answer every run. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** One cluster of correlated observations (all the tokens of one Meta): its successes and its size. */
export interface Cluster {
  k: number;
  n: number;
}

/**
 * Percentile interval (95%) for the pooled rate of `a` minus the pooled rate of `b`, resampling whole clusters with replacement, so a
 * Meta's many tokens count as one draw rather than as many independent ones. `b` may be a fixed rate (the base rate over thousands of
 * creates). Returns undefined when `a` has no cluster. Deterministic for a given seed.
 */
export function clusterBootstrapDiff(a: readonly Cluster[], b: readonly Cluster[] | number, resamples = 2_000, seed = 20261111): Interval | undefined {
  if (a.length === 0 || (typeof b !== "number" && b.length === 0)) return undefined;
  const rand = seededRandom(seed);
  const draw = (cs: readonly Cluster[]) => {
    let k = 0;
    let n = 0;
    for (let i = 0; i < cs.length; i++) {
      const c = cs[Math.floor(rand() * cs.length)] as Cluster;
      k += c.k;
      n += c.n;
    }
    return n > 0 ? k / n : 0;
  };
  const diffs: number[] = [];
  for (let r = 0; r < resamples; r++) diffs.push(draw(a) - (typeof b === "number" ? b : draw(b)));
  diffs.sort((x, y) => x - y);
  return { low: diffs[Math.floor(0.025 * (resamples - 1))] as number, high: diffs[Math.ceil(0.975 * (resamples - 1))] as number };
}
