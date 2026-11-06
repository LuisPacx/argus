// Polls every configured RSS feed once (RssSource, the production code) and records a sample of public headlines
// for calibrating the Narrative join threshold (docs/adr/0006). One request per feed, no retries, no loop against a site.
//
//   node scripts/collect-narrative-sample.mjs <fixture-out.json> [<full-out.json>]
//
// The fixture keeps title, Source id and link only. The optional full file also keeps the summary and published time
// (the embedder reads the summary); write it outside the repo.
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadRssSources } from "../packages/core/src/sources/feeds.ts";

const [fixtureOut, fullOut] = process.argv.slice(2);
if (!fixtureOut) {
  console.error("usage: node scripts/collect-narrative-sample.mjs <fixture-out.json> [<full-out.json>]");
  process.exit(2);
}

const sources = loadRssSources(fileURLToPath(new URL("../config/rss-feeds.json", import.meta.url)));
const polled = await Promise.all(
  sources.map(async (source) => {
    try {
      return { source, signals: await source.poll() };
    } catch (err) {
      console.error(`${source.id}: ${err instanceof Error ? err.message : err}`);
      return { source, signals: [] };
    }
  }),
);

const signals = polled.flatMap((p) => p.signals);
for (const p of polled) console.error(`${p.source.id}: ${p.signals.length} items`);

const slim = signals.map((s) => ({ sourceId: s.sourceId, title: s.title, url: s.url }));
writeFileSync(fixtureOut, JSON.stringify(slim, null, 1) + "\n");
if (fullOut) writeFileSync(fullOut, JSON.stringify(signals, null, 1) + "\n");
console.error(`${signals.length} items from ${sources.length} feeds`);
