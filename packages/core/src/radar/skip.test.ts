import path from "node:path";
import { describe, expect, it } from "vitest";
import { Datastore } from "../datastore.ts";
import { aMeta, saveCurrentRun } from "../testing/meta-current.ts";
import { at, aCandidate, anOkRead, T0 } from "../testing/radar.ts";
import { tempDir } from "../testing/temp.ts";
import { createRadarJob } from "./job.ts";
import { isSkipped, skipKeys } from "./skip.ts";

const theme = (key: string, label: string) => ({ key, label, tokens: 10, creators: 5 });
function storeWith(metas: ReturnType<typeof aMeta>[], watching: ReturnType<typeof aMeta>[] = []) {
  const store = Datastore.open(path.join(tempDir("radar-skip-"), "argus.db"));
  saveCurrentRun(store, T0, { metas, watching });
  return store;
}

describe("the skip rule", () => {
  it("skips a term equal to a current Meta's label, to one of its merged theme labels, or to a Watching subject", () => {
    const store = storeWith([aMeta("chair", { label: "Empty Chair", themes: [theme("chair", "Empty Chair"), theme("hot-seat", "Hot Seat Inu")] })], [aMeta("cloud", { label: "Cloud Cat" })]);
    const keys = skipKeys(store.currentMetas());
    for (const term of ["Empty Chair", "empty chair", "#EmptyChair", "Hot Seat Inu", "hot seat inu", "Cloud Cat", "cloud  cat!"]) expect(isSkipped(term, keys), term).toBe(true);
    for (const term of ["Empty Table", "Cat", "puka nacua", "", "🔥"]) expect(isSkipped(term, keys), term).toBe(false);
    store.close();
  });

  it("folds both sides: a Meta labelled 'GTA 6' skips 'gta vi', and a Meta labelled 'GTA VI' skips 'gta 6' and 'GTA6'", () => {
    const six = storeWith([aMeta("gta", { label: "GTA 6" })]);
    const sixKeys = skipKeys(six.currentMetas());
    expect(isSkipped("gta vi", sixKeys)).toBe(true);
    expect(isSkipped("GTA VI", sixKeys)).toBe(true);
    expect(isSkipped("GTA 5", sixKeys)).toBe(false);
    six.close();
    const vi = storeWith([aMeta("gta", { label: "GTA VI" })]);
    const viKeys = skipKeys(vi.currentMetas());
    for (const term of ["gta 6", "GTA6", "#gta6"]) expect(isSkipped(term, viKeys), term).toBe(true);
    vi.close();
  });

  it("no run yet skips nothing", () => {
    expect([...skipKeys(undefined)]).toEqual([]);
  });

  it("a term that is a current Meta is not stored as a Trend (kept in the readings only); a different term is", async () => {
    const store = storeWith([aMeta("gta", { label: "GTA 6" })], [aMeta("cloud", { label: "Cloud Cat", themes: [theme("c2", "Sky Kitty")] })]);
    const read = anOkRead([aCandidate("gta vi", 50_000), aCandidate("Sky Kitty", 20_000), aCandidate("Cloud Cat", 9_000), aCandidate("Zverev", 25_000)]);
    const job = createRadarJob({ store, settings: { enabled: true, searchesPerTick: 30 }, reader: { read: async () => read }, geos: ["US"], dex: { search: async () => [] }, now: () => at(0), sleep: async () => {} });
    const r = await job();
    expect(r).toMatchObject({ readings: 4, newTrends: 1, skipped: 3 });
    expect(store.radar.view(at(1)).trends.map((t) => t.term)).toEqual(["Zverev"]);
    expect(store.radar.trendByKey("gta6")).toBeUndefined();
    store.close();
  });
});
