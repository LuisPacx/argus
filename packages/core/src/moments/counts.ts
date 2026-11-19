/** The five figures of a post's action row. `null` is a figure X did not show: never read as zero. */
export interface PostCounts {
  replies: number | null;
  reposts: number | null;
  likes: number | null;
  bookmarks: number | null;
  views: number | null;
}

export const NO_COUNTS: PostCounts = { replies: null, reposts: null, likes: null, bookmarks: null, views: null };

const MULTIPLIER: Record<string, number> = { "": 1, K: 1e3, M: 1e6, B: 1e9 };

/** One figure with its word: "44 replies", "1 repost", "1.2K likes", "18,856 views". */
const FIGURE_RE = /(\d[\d,]*(?:\.\d+)?)\s*([KMB]?)\s+(replies|reply|reposts?|likes?|bookmarks?|views?)\b/gi;

function figure(digits: string, suffix: string): number | null {
  const n = Number(digits.replaceAll(",", ""));
  if (!Number.isFinite(n)) return null;
  const v = Math.round(n * (MULTIPLIER[suffix.toUpperCase()] ?? 1));
  return Number.isSafeInteger(v) ? v : null;
}

/**
 * The counts out of the action row's aria-label, for example "44 replies, 39 reposts, 185 likes, 4 bookmarks, 18856 views". A figure the
 * label does not carry is `null` (views are sometimes not shown); a label that is not one gives all nulls. "1.2K" and "3M" forms parse.
 * The label is third-party text: it is capped at 500 characters and read by one linear literal pattern.
 */
export function parseCounts(label: unknown): PostCounts {
  const out: PostCounts = { ...NO_COUNTS };
  if (typeof label !== "string" || label.length > 500) return out;
  for (const m of label.matchAll(FIGURE_RE)) {
    const value = figure(m[1]!, m[2]!);
    if (value === null) continue;
    const word = m[3]!.toLowerCase();
    const key = word.startsWith("repl") ? "replies" : word.startsWith("repost") ? "reposts" : word.startsWith("like") ? "likes" : word.startsWith("bookmark") ? "bookmarks" : "views";
    out[key] ??= value;
  }
  return out;
}
