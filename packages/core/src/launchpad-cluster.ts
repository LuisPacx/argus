import type { Datastore, StoredSignal } from "./datastore.ts";
import { claimOrder, crossSourceForms, launchpadKeys, parseLaunchpadSignal, parseTokenTitle, type LaunchpadKeys } from "./launchpad-subject.ts";
import type { ClusterConfig, Embedder } from "./narratives.ts";

const DEXSCREENER_SOURCE_ID = "dexscreener:trending";

/**
 * How launchpad Signals (token creates and bonds, Source `pumpportal:events`) are clustered (viral sources ticket 01, docs/adr/0007
 * amendment of 2026-11-14). They are not embedded. Every create is the same template around a token name, and a running-mean centroid over
 * tens of thousands of them converges on the template (Narrative 351: 65,189 Signals, a generic "token launch" point), so nearest-centroid
 * is the wrong tool; the name and ticker, which are what the creator wrote, are matched exactly instead:
 *
 *   1. A create joins the Narrative that holds its name key or its ticker key (`claimOrder`: same kind first), if that Narrative is recent
 *      and under `maxNarrativeSignals`. The keys come from ticket 03's normaliser (`meta/key.ts`), so `Misu`, `MISU` and `米苏 ($MISU)` agree
 *      with the Meta ranking, and generic keys (`coin`, `meme`, `ai`) never match.
 *   2. Otherwise it starts a Narrative and claims its own keys. The Narrative holds only keys its first Signal brought, so a copycat with an
 *      unrelated ticker cannot make a later token with that ticker join the wrong Narrative.
 *   3. A bond (migrate) carries no name, only the mint. It joins the Narrative of its create when that is a launchpad Narrative that is not full;
 *      else it takes the subject of its create (the stored Signal, else the Study's row for the mint) and goes through 1 and 2. A bond whose
 *      create nobody knows stands alone: a Narrative of one that is never joined.
 *   4. A token with no name, only generic keys, or a title that is just a mint stands alone the same way.
 */

export type LaunchpadStore = Pick<Datastore, "claimsForKey" | "knownToken" | "createNarrative" | "joinNarrative">;
export type CrossStore = Pick<Datastore, "claimsForKey" | "recentPhraseCount" | "joinNarrative">;

/** Claims that can still be joined: recent, and under the Narrative size bound. */
function joinable(claim: { signalCount: number; lastSignalAt: string }, since: string, config: ClusterConfig): boolean {
  return claim.lastSignalAt >= since && claim.signalCount < config.maxNarrativeSignals;
}

/**
 * Puts one launchpad Signal in a Narrative. Never embeds. Returns whether it started a Narrative. `since` is the start of the join window
 * (ISO): a Narrative that has had no Signal since then no longer holds its keys.
 */
export function placeLaunchpadSignal(
  store: LaunchpadStore,
  signal: StoredSignal,
  now: string,
  since: string,
  config: ClusterConfig,
  embedder: { id: string; dimension: number },
): { created: boolean } {
  const lp = parseLaunchpadSignal(signal);
  const alone = (): { created: boolean } => {
    store.createNarrative(signal, [], now, embedder, { title: signal.title.slice(0, 200), keys: [] });
    return { created: true };
  };
  if (!lp) return alone();

  let label = lp.label;
  let keys: LaunchpadKeys | undefined = lp.named ? launchpadKeys(lp.name, lp.symbol) : undefined;
  if (lp.kind === "migrate") {
    // A bond has no name of its own (the migrate message carries none): it follows its create.
    const known = store.knownToken(lp.mint);
    if (known) {
      // Recent and under the bound, like any join: a bond three days after the last Signal does not revive a Narrative that has lapsed (its keys may belong to a successor).
      if (known.narrativeKind === "launchpad" && known.narrativeId !== null && joinable({ signalCount: known.narrativeSignalCount, lastSignalAt: known.narrativeLastSignalAt }, since, config)) {
        store.joinNarrative(known.narrativeId, signal, [], now);
        return { created: false };
      }
      const token = known.title !== undefined ? parseLaunchpadSignal({ id: `pumpportal:events:create:${lp.mint}`, sourceId: signal.sourceId, title: known.title }) : undefined;
      if (token?.named) {
        label = token.label;
        keys = launchpadKeys(token.name, token.symbol);
      } else if (known.name !== undefined && (known.name !== "" || known.symbol !== "")) {
        label = known.name !== "" && known.symbol !== "" ? `${known.name} ($${known.symbol})` : known.name || (known.symbol ?? "");
        keys = launchpadKeys(known.name, known.symbol ?? "");
      }
    }
  }
  if (!keys || (keys.name === undefined && keys.ticker === undefined)) return alone();

  for (const { role, key } of claimOrder(keys)) {
    const claim = store.claimsForKey(key).find((c) => c.role === role && joinable(c, since, config));
    if (claim) {
      store.joinNarrative(claim.narrativeId, signal, [], now);
      return { created: false };
    }
  }
  const claimed: Array<{ role: "name" | "ticker"; key: string }> = [];
  if (keys.name !== undefined) claimed.push({ role: "name", key: keys.name });
  if (keys.ticker !== undefined) claimed.push({ role: "ticker", key: keys.ticker });
  store.createNarrative(signal, [], now, embedder, { title: label.slice(0, 200), keys: claimed });
  return { created: true };
}

/**
 * The launchpad Narrative a Signal from another Source joins, if any (ticket 01, candidate 4). Precision first, so it is narrow:
 *   - DexScreener Signals are tokens (`Name ($TICKER)`): the token's own keys, matched the way a create's are.
 *   - Any other Signal (news, Trends, GitHub): a phrase of its headline (`crossSourceForms`) that is a key some launchpad Narrative holds,
 *     where that Narrative has at least `crossMinSignals` Signals (one lone token is junk, not a subject) and the phrase is rare in recent
 *     headlines (at most `crossMaxDocFreq` of them, the Signal itself counted), so `big`, `ai`, `trump` and `coin` never link. A headline that
 *     matches two different Narratives joins neither.
 * Returns the Narrative id.
 */
export function crossSourceTarget(
  store: CrossStore,
  signal: StoredSignal,
  since: string,
  config: ClusterConfig,
  embedder: Pick<Embedder, "isCommonWord">,
): number | undefined {
  const usable = (c: { signalCount: number; lastSignalAt: string }) => joinable(c, since, config) && c.signalCount >= config.crossMinSignals;
  if (signal.sourceId === DEXSCREENER_SOURCE_ID) {
    // Only by its name: a shared three-letter ticker (`STM`, `BOOM`, `BIG`) joins unrelated tokens, a shared name does not.
    const token = parseTokenTitle(signal.title);
    const keys = launchpadKeys(token.name, token.symbol);
    for (const { role, key } of claimOrder({ name: keys.name, ticker: undefined })) {
      const claim = store.claimsForKey(key).find((c) => c.role === role && usable(c));
      if (claim) return claim.narrativeId;
    }
    return undefined;
  }
  const hits = new Set<number>();
  for (const form of crossSourceForms(signal.title, embedder.isCommonWord)) {
    const matching = store.claimsForKey(form).filter(usable);
    if (matching.length === 0 || store.recentPhraseCount(form, since) > config.crossMaxDocFreq) continue;
    for (const c of matching) hits.add(c.narrativeId);
  }
  return hits.size === 1 ? [...hits][0] : undefined;
}
