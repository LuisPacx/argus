import { readFileSync } from "node:fs";
import { cleanTerm } from "./clean.ts";
import { RADAR_CONFIG } from "./config.ts";

/**
 * The radar's own news feed list, `config/radar-feeds.json` (ticket 02). It is NOT `config/rss-feeds.json`: feeds added there would add Signals and
 * change Narrative clustering (ADR 0016 decision 1). A feed's id is `radar:<slug>`; `radar:google:` is the Google countries' prefix and is never a feed.
 */

export interface RadarFeed {
  /** `radar:<slug>`, unique. Also the name of the feed as a source of readings. */
  id: string;
  label: string;
  /** https only. */
  url: string;
  /** entertainment, gaming, sport or upcoming (the page does not need it). */
  group: string;
}

const ID = /^radar:[a-z0-9][a-z0-9-]{0,39}$/;

/** Reads and checks the list. Throws, naming the file and the feed, on anything that is not a plain list of well-formed entries. */
export function loadRadarFeeds(path: string): RadarFeed[] {
  const data: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!Array.isArray(data)) throw new Error(`${path}: expected a JSON array of feeds`);
  if (data.length > RADAR_CONFIG.feedsMax) throw new Error(`${path}: ${data.length} feeds is over the cap of ${RADAR_CONFIG.feedsMax}`);
  const seen = new Set<string>();
  return data.map((entry: unknown, i): RadarFeed => {
    const e = (entry ?? {}) as Record<string, unknown>;
    const { id, label, url, group } = e;
    if (typeof id !== "string" || !ID.test(id) || id.startsWith("radar:google")) throw new Error(`${path}: feed #${i + 1} needs an id like "radar:some-name" (lower case, digits, hyphens)`);
    if (typeof label !== "string" || cleanTerm(label, 60) === "") throw new Error(`${path}: feed ${id} needs a label`);
    if (typeof url !== "string" || !url.startsWith("https://") || url.length > 500) throw new Error(`${path}: feed ${id} needs an https url`);
    if (seen.has(id)) throw new Error(`${path}: duplicate feed id ${id}`);
    seen.add(id);
    return { id, label: cleanTerm(label, 60), url, group: typeof group === "string" ? cleanTerm(group, 20) : "" };
  });
}
