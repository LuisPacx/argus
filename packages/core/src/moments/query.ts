import { MOMENT_CONFIG } from "./config.ts";

/**
 * A Watched topic for this ticket (GLOSSARY): a label, its search spellings and a start time (posts before it are ignored). It comes from
 * configuration now (`ARGUS_MOMENT_TOPIC`); ticket 05 replaces that with a table. Every word is text a person or a Meta wrote, so it is
 * untrusted: the query is built from cleaned words and operators that are literals in this file, never from free text.
 */
export interface MomentTopic {
  label: string;
  /** ISO time with a trailing Z. */
  startsAt: string;
  spellings: string[];
}

/** The topic cannot be searched (empty, malformed, or nothing left of its words after cleaning). */
export class TopicRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TopicRefused";
  }
}

/** The operators of the query, as literals. Nothing a topic says can add another. */
const OR = " OR ";
const FILTER_VIDEOS = "filter:videos";
const MIN_FAVES = `min_faves:${MOMENT_CONFIG.minFaves}`;

const NOT_WORD_CHARS_RE = /[^\p{L}\p{Nd}#$ ]+/gu;
const OPERATOR_WORDS = new Set(["or", "and", "not"]);
const ISO_Z_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?Z$/;

/**
 * A spelling reduced to letters, digits, spaces, `#` and `$`: every other character (an operator's colon, a minus, a parenthesis, a quote,
 * a control or format character) becomes a space, the bare words OR, AND and NOT are dropped, whitespace is collapsed and the result is cut
 * to 40 characters. A result with no letter or digit is empty.
 */
export function cleanSpelling(raw: unknown): string {
  if (typeof raw !== "string") return "";
  const spaced = raw.slice(0, MOMENT_CONFIG.spellingChars * 8).replace(NOT_WORD_CHARS_RE, " ");
  const words = spaced.split(" ").filter((w) => w !== "" && !OPERATOR_WORDS.has(w.toLowerCase()));
  const cut = words.join(" ").slice(0, MOMENT_CONFIG.spellingChars).trim();
  return /[\p{L}\p{Nd}]/u.test(cut) ? cut : "";
}

/** The `since:` stamp of a start time: `2026-11-19_05:00:00_UTC`. */
export function sinceStamp(startsAt: Date): string {
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  const d = startsAt;
  return `${p(d.getUTCFullYear(), 4)}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}_${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}_UTC`;
}

/** The label as the page shows it: control and format characters out, one line, 60 characters. */
export function cleanLabelText(raw: unknown): string {
  if (typeof raw !== "string") return "";
  return raw.slice(0, 1_000).replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, " ").replace(/\s+/g, " ").trim().slice(0, MOMENT_CONFIG.labelChars).trim();
}

/** One search page to load: `top` and `live` are X's own names of the Top and Latest tabs. */
export interface ScanTarget {
  id: "top" | "live";
  query: string;
  url: string;
}

/**
 * The rising-clips queries for a topic (spec section 3.1, group B): `(<spelling> OR <spelling>) filter:videos min_faves:500
 * since:<start>`, once for the Top tab and once for Latest. A spelling of several words is put in quotes by this code (a cleaned spelling
 * has no quote of its own). A topic with no spelling left is a refusal, never an unfiltered search.
 */
export function momentQueries(topic: MomentTopic): ScanTarget[] {
  const startsAt = new Date(topic.startsAt);
  if (typeof topic.startsAt !== "string" || !ISO_Z_RE.test(topic.startsAt) || Number.isNaN(startsAt.getTime())) throw new TopicRefused("the topic's start time is not an ISO time ending in Z");
  const spellings = [...new Set((Array.isArray(topic.spellings) ? topic.spellings : []).slice(0, MOMENT_CONFIG.maxSpellings).map(cleanSpelling).filter((s) => s !== ""))];
  if (spellings.length === 0) throw new TopicRefused("the topic has no spelling left after cleaning");
  const list = spellings.map((s) => (s.includes(" ") ? `"${s}"` : s)).join(OR);
  const query = `(${list}) ${FILTER_VIDEOS} ${MIN_FAVES} since:${sinceStamp(startsAt)}`;
  const url = (f: "top" | "live") => `https://x.com/search?q=${encodeURIComponent(query)}&f=${f}`;
  return [
    { id: "top", query, url: url("top") },
    { id: "live", query, url: url("live") },
  ];
}

/**
 * ARGUS_MOMENT_TOPIC: one JSON object `{ "label", "startsAt", "spellings" }`. Unset or empty is no topic (null). Anything else that is not a
 * valid topic is an error, never a fallback. The returned topic is already cleaned: the label cut, the spellings cleaned and de-duplicated.
 */
export function parseTopic(raw: string | undefined): MomentTopic | null {
  if (raw === undefined || raw.trim() === "") return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new TopicRefused("ARGUS_MOMENT_TOPIC is not valid JSON");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new TopicRefused("ARGUS_MOMENT_TOPIC must be a JSON object");
  const extra = Object.keys(value).filter((k) => k !== "label" && k !== "startsAt" && k !== "spellings");
  if (extra.length > 0) throw new TopicRefused("ARGUS_MOMENT_TOPIC has keys other than label, startsAt and spellings");
  const { label, startsAt, spellings } = value as Record<string, unknown>;
  const cleanLabel = cleanLabelText(label);
  if (cleanLabel === "") throw new TopicRefused("ARGUS_MOMENT_TOPIC needs a label");
  if (typeof startsAt !== "string" || !ISO_Z_RE.test(startsAt) || Number.isNaN(Date.parse(startsAt))) throw new TopicRefused("ARGUS_MOMENT_TOPIC startsAt must be an ISO time ending in Z");
  if (!Array.isArray(spellings) || spellings.length === 0) throw new TopicRefused("ARGUS_MOMENT_TOPIC needs at least one spelling");
  if (spellings.length > MOMENT_CONFIG.maxSpellings) throw new TopicRefused(`ARGUS_MOMENT_TOPIC has more than ${MOMENT_CONFIG.maxSpellings} spellings`);
  const cleaned = [...new Set(spellings.map(cleanSpelling).filter((s) => s !== ""))];
  if (cleaned.length === 0) throw new TopicRefused("ARGUS_MOMENT_TOPIC has no spelling left after cleaning");
  return { label: cleanLabel, startsAt, spellings: cleaned };
}
