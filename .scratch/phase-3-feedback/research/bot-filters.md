# Separating organic from bot-driven pump.fun migrations

Note 2026-11-08: RugCheck was dropped (terms unavailable, user decision); the RugCheck material below is a historical record and no plan uses it.

Researched 2026-11-07. Builds on `data-sources.md` (not repeated). Terms follow `GLOSSARY.md`. No repo toolchain was run; I made single HTTP requests to DexScreener, RugCheck and GitHub, and read public docs and papers. "Not verified" marks anything I could not confirm from the owner of the claim. SOL/USD price is not assumed anywhere; costs are in credits or SOL.

Scale: about 14k launches/day, about 100-300 migrations/day, plus an equal random control (Round 3 Q16).

## Answer in brief

- DexScreener has no maker, holder or buyer-count fields. It can only give crude post-migration hints. Real bot metrics need per-wallet trade data, which we can rebuild from the chain (Helius) for roughly 0.5M-2M credits per month.
- Recommended filter: 5 metrics (section 5), all computable before migration from the bonding-curve trades. Thresholds are hypotheses from vendor docs and papers; no published threshold is validated on pump.fun migrators.
- Cost: Helius Developer $49/mo (Free's 1M credits is likely too small once all steps run). RugCheck and DexScreener are $0.

## 1. DexScreener

Sources: [API reference](https://docs.dexscreener.com/api/reference), [API terms](https://docs.dexscreener.com/api/api-terms-and-conditions), and one live request to `GET /token-pairs/v1/solana/{mint}` today (HTTP 200).

Pair object, exact fields (reference `Pair` schema, matched by the live response): `chainId`, `dexId`, `url`, `pairAddress`, `labels`, `baseToken{address,name,symbol}`, `quoteToken{...}`, `priceNative`, `priceUsd`, `txns`, `volume`, `priceChange`, `liquidity{usd,base,quote}`, `fdv`, `marketCap`, `pairCreatedAt`, `info{imageUrl,websites,socials}`, `boosts{active}`.

- `txns`, `volume`, `priceChange` each have windows `m5`, `h1`, `h6`, `h24` (live response). `txns.<w>` is `{buys, sells}` (counts of trades, not wallets).
- The live response also had `info.header`, `info.openGraph`; `boosts` was absent for an unboosted pair (so treat it as optional).
- Endpoints: `token-pairs/v1/{chainId}/{token}`, `tokens/v1/{chainId}/{addresses}`, `latest/dex/pairs/...`, `latest/dex/search`, `token-profiles/*`, `token-boosts/*`, `community-takeovers`, `ads`, `orders`, `metas/*`.
- Unique makers, holders, buyer counts, trade-level data, wallets: not in the schema and not in my live response. Confirmed absent.
- Rate limits: the reference states 60/min for the profile, takeover, ads and meta endpoints only; pair/token endpoints are not stated. The API terms say limits are "detailed during the API Services checkout stage". A 300/min figure circulates in third-party MCP docs; unverified. My live response showed no rate-limit headers.
- ToS: license is "limited, non-exclusive, non-transferable, non-assignable, and revocable"; "may be used for both non-commercial and commercial purposes"; you may not use it to build a product that primarily competes with DEX Screener; access may be suspended "at our sole discretion, at any time, with or without notice". No clause on storage or attribution. Argus is not a competing screener, so use looks allowed, but I am not a lawyer and the terms are dated 2023.

What can flag bots (weakly, only after migration, only the pumpswap pair):
- Average trade size = `volume.h1 / (buys+sells)`. In my sample pair: $55,762 / 1,065 txns, about $52 per trade. Very small uniform trades plus huge counts hint at wash. No threshold is published.
- Buy/sell skew in `txns` windows; `priceChange.h1`/`h6` as a drawdown proxy (the window endpoints, not the minimum).
- `liquidity.usd` against `marketCap`; `pairCreatedAt` (pump swap pair creation time, usable as a migration time cross-check).
- `info.websites/socials` present or not; `boosts.active` (paid promotion).
- It cannot say who traded, so it cannot detect bundles, snipers, insiders or same-source funding. Use it only as a snapshot helper, as `data-sources.md` already recommends.

## 2. On-chain via the pump program (Helius) and PumpPortal

### 2.1 What the chain gives per token (primary: pump IDL)

[`pump-fun/pump-public-docs idl/pump.json`](https://github.com/pump-fun/pump-public-docs/blob/main/idl/pump.json), parsed today. `TradeEvent` fields: `mint`, `sol_amount`, `token_amount`, `is_buy`, `user`, `timestamp`, virtual/real reserves, `fee_recipient`, `fee`, `creator`, `creator_fee`, `ix_name`, `quote_mint`, `quote_amount`, and more. `CreateEvent`: `mint`, `bonding_curve`, `user`, `creator`, `uri`, `timestamp`, `is_mayhem_mode`, `is_cashback_enabled`, `quote_mint`. No bot flag, no slot field in events: slot comes from the transaction. The account that appears in every trade is the `BondingCurve` PDA, so `getSignaturesForAddress` / `getTransactionsForAddress` on it lists all trades for a token.

From the events plus transaction data, each question from the task:

| Question | Feasible? | How |
|---|---|---|
| Unique buyer wallets before migration | Yes | Distinct `user` where `is_buy` in `TradeEvent`s of the curve |
| Buys in the creation slot / block (bundles) | Yes | Slot of the create transaction (from `getTransaction`); buys with the same slot |
| Jito bundle use | Partly | Official Jito APIs look up bundle by bundle ID, not by transaction signature (searched; I found no signature to bundle route). Practical proxy (my inference, not documented): the transaction contains a SOL transfer to a known Jito tip account, or shares a slot and adjacent index with the create. The tip-account list was not fetched here: verify it from Jito docs |
| Dev/creator buys and sells | Yes | `TradeEvent.user == creator`; `CreateEvent.creator` |
| Top-10 holder share at migration | Yes | Rebuild balances by summing `token_amount` per `user` from the trade events (excluding the curve and the pool), or `getTokenLargestAccounts` at migration time (Helius table lists no special price, so likely 1 credit; not verified) |
| Wallets funded from the same source | Yes, at higher cost | For each early buyer, find its first inbound SOL transfer (oldest signature, then `getTransaction`), group by sender, exclude exchanges. MELT uses exactly this ("fund-flow") |

### 2.2 PumpPortal

[PumpPortal real-time docs](https://pumpportal.fun/data-api/real-time/): `subscribeNewToken` and `subscribeMigration` are free; `subscribeTokenTrade` and `subscribeAccountTrade` need an API key and a wallet with at least 0.02 SOL and cost 0.01 SOL per 10,000 messages; one connection only. The page documents no payload fields (trade or create). Our repo's `pumpportal.ts` reads some, but I did not verify the trade payload here.

Cost at our volume: we do not know which of the 14k tokens migrate until they do, so streaming all trades is the large number. Even migrators alone, at the median of about 457 swaps ([arXiv 2602.14860](https://arxiv.org/html/2602.14860v1)), would be about 150k messages/day, 4.5M/month = 450 units = 4.5 SOL per month for 300/day, before any control tokens. A post-hoc RPC pull on only the sampled set is cheaper and needs no wallet (ADR 0002). Decision: RPC backfill for the sampled set, PumpPortal only for the free create/migrate events.

### 2.3 RPC credit cost (Helius)

Sources: [Helius credits](https://www.helius.dev/docs/billing/credits), [pricing](https://www.helius.dev/pricing), [getTransactionsForAddress](https://www.helius.dev/docs/rpc/gettransactionsforaddress).

- `getTransaction` 1 credit; `getSignaturesForAddress` 1; `getTransactionsForAddress` (gTFA) 10 credits per 100 full transactions returned (10 minimum), up to 1,000 per call, filter by slot and block time, mainnet retention unlimited. The page does not say which plan includes gTFA; I could not confirm it on Free. Other RPC calls 1 credit.
- Plans: Free $0, 1M credits, 10 RPC req/s; Developer $49, 10M credits, 50 req/s, extra $5 per million.

Estimates (my arithmetic; assumptions: 300 migrators + 300 controls per day; about 500 trades per migrator, about 100 per control; 20 early buyers funded-source traced per token):

| Step | Credits per token | Per day | Per month |
|---|---|---|---|
| All curve trades via `getTransaction` (1 per trade) | about 500 migrator, about 100 control | about 180k | about 5.4M |
| All curve trades via gTFA (full, 10 per 100) | about 50 migrator, about 10 control | about 18k | about 0.5M |
| Funding trace, 20 early buyers: about 2 calls plus 1 `getTransaction` each | about 60 | about 36k | about 1.1M |
| Top holders / misc | about 2 | about 1k | about 0.02M |

So: with gTFA about 1.6M credits/month (above Free's 1M, inside Developer's 10M); without gTFA about 6.5M/month (still inside Developer). Plan on Developer, $49. If sampling shrinks to 100 migrators + 100 controls per day, gTFA keeps it near 0.5M (inside Free, if gTFA is allowed on Free).

## 3. Third-party scorers

| Provider | Official API? | What it gives on bundles/snipers/insiders | Cost | ToS / access | Verified how |
|---|---|---|---|---|---|
| RugCheck | Yes, public Swagger at `api.rugcheck.xyz` | Live call today on a pump.fun token (HTTP 200): `GET /v1/tokens/{mint}/report` returned `graphInsidersDetected` (count), `insiderNetworks` [{id, size, type, tokenAmount, currentHolding, activeAccounts}], `topHolders` [{owner, pct, insider}], `creator`, `creatorBalance`, `totalHolders`, `rugged`, `launchpad`, `risks`, `score`. The Swagger declares no schema for the full report (only the summary endpoint has one), so those names come from my one response. Also `/v1/tokens/{id}/insiders/graph` and `/insiders/networks` | Free for this call; no key used. Header `x-rate-limit-limit: 15` (window not stated). `refresh=true` is "paid API keys only". Bulk endpoints need auth (secondary source) | No ToS or pricing page found; not verified | Primary: swagger.json, live response |
| Mobula | Yes, [docs](https://docs.mobula.io/almanac/detecting-snipers-bundlers) | `token/details` fields: `top10HoldingsPercentage`, `devHoldingsPercentage`, `snipersHoldingsPercentage`, `bundlersHoldingsPercentage`, `insidersHoldingsPercentage`; holder positions with `label` sniper/bundler | Page states no price; not verified | Not read | Primary docs; I did not call it |
| Birdeye | Yes | `token_security`-style endpoint with top-10 percent and creator percent (field names only from a third-party type file); no documented bundle or sniper field found | Credit-based; plans conflict across pages (see `data-sources.md`) | Not read | Docs pages returned 404/redirects to me; mostly secondary. Weak evidence |
| Solscan | Yes, Pro API | `GET /v2.0/token/holders` returns holders with `owner`, `percentage`, `value`, `rank`; no bundle, sniper or insider field | PRO plan required, price not stated on the page | Key in `token` header | [Primary docs](https://pro-api.solscan.io/pro-api-docs/v2.0/reference/v2-token-holders) |
| GMGN | An "Access data API" exists, behind a whitelist; not self-serve | Secondary sources describe `bundler_rate`, `rat_trader_amount_rate`, `top_10_holder_rate`; not confirmed from GMGN | Unknown | [docs.gmgn.ai](https://docs.gmgn.ai) refers to a separate whitelist page; scraping actors on Apify exist but are unofficial | Official page has no schema; skip |
| Bitquery | Yes | Documented queries: first 100 buyers, top 10 holders, trades by creation `Block.Slot` ordered by `Transaction.Index` (bundle check), dev holdings. Real-time data window about 12 hours only; older needs Data Store/archive | $0 trial; Personal is non-commercial; Pro about $69 (from `data-sources.md`; page contradicts itself) | Commercial plan needed | [Bitquery Pump.fun docs](https://docs.bitquery.io/docs/examples/Solana/Pump-Fun-API/) |

Verdict: RugCheck is the only free provider with insider-network output that I verified end to end. Caveat: it returns current state. A call after migration or days later reflects holders now, not at migration, which is hindsight leakage for the Study (Round 3 Q16: frozen snapshots, blind). Call it at the capture age and store the response. Its insider definition is its own and unvalidated. For metrics that must be as-of migration, compute them ourselves from trades.

## 4. Published heuristics and papers (with thresholds)

| Source | What it says | Thresholds | Quality |
|---|---|---|---|
| [MELT, arXiv 2602.13480](https://arxiv.org/abs/2602.13480) (Hu et al.; data 1 Dec 2024 to 1 Mar 2025; fetched title is "MELT"; a search snippet called it "MemeTrans") | Bundle trace = accounts sharing a co-purchase transaction, a funding address (CEXs excluded), or a Jito bundle ID. Bundled accounts hold 28.13% of holders and 36.50% of supply overall. After merging bundles, top-10 share rises about 24 points for high-risk tokens vs about 6 for low-risk. First 10 and 20 buyers hold about 17 and 19 more points of supply in high-risk tokens. 122 features; market activity and bundle statistics matter most. Best model AUPRC 0.5827 vs 0.2589 random | Label: high-risk = lowest price within 20 min after migration < 0.3 of migration price (or manipulated). Excluded: sale duration < 1 min or < 100 holders. 84% of their 41k tokens were high-risk | Peer-reviewed-style preprint, on-chain. Base rate of "high-risk" is much higher than ours, so thresholds do not transfer directly. I read the HTML summary; the PDF body failed to parse |
| [Marino et al., arXiv 2602.14860](https://arxiv.org/html/2602.14860v1) | Flags `isBot=1` when a transaction calls the contract directly rather than via the website (how it was derived from chain data was not stated in what I read). Conditioning on non-bot trade share above 0.3 or 0.7 raises graduation probability, e.g. at 100 SOL from 0.638 to 0.748 with the 0.3 filter. Median 4.4 min to graduate. Ultra-fast graduations under 2 s do not change the curve. Pre-graduation dumps defined at −4 robust sigma | Non-bot share 0.3 and 0.7 | Primary on-chain; about the cause of graduating, not about post-migration dumps. Note that it treats more bot activity as lower graduation chance, not as the "bot-driven migration" we want to exclude: the sign differs |
| [Pine Analytics, "Exit Liquidity Machines"](https://pineanalytics.substack.com/p/exit-liquidity-machines) | Over 50% of pump.fun launches are sniped in the creation block (unfiltered). Deployer-funded snipers are about 1.75% of launches (15,000+ tokens). 87% of those snipes profitable; over 55% fully exited within 1 minute, about 85% within 5 | Proposes, unvalidated: flag if about half of early volume is in the first 10 blocks, or 3 wallets hold about 80% | Vendor report; the author says the concentration thresholds are illustrative. Over 50% means "any buy in creation block" is too weak a flag |
| [Mobula docs](https://docs.mobula.io/almanac/detecting-snipers-bundlers) | Sniper = buys in first 0-3 blocks plus a fresh wallet, pre-launch funding or priority fees. Bundler = same-block buys, common funding; cluster of 3 or more | Snipers combined over 20% red; bundler networks of 10 or more wallets red; top-10 (excluding pools) healthy under 30%, yellow 25-40%, red over 50%; dev under 5% healthy | Vendor heuristics, unvalidated |
| [Bitquery, "Solana volume numbers are a lie"](https://bitquery.io/blog/solana-volume-numbers-are-a-lie) | Wash signals: trades per wallet, average trade size, share of wallets on both sides, round-trip ratio, shared first-funder of flagged wallets | Case: 233 wallets, 174 trades per wallet, 96% both-sided, top wash wallets' round-trip 0.95-1.00; "about 90%" of activity from wallets that bought and sold the same dollar amount is not real liquidity | One case study of 5 hand-picked tokens, not pump.fun curve specific; no formula or threshold published |
| [arXiv 2607.02795](https://arxiv.org/abs/2607.02795) (wallet rings) | Persistent groups of 2-12 wallets co-appearing as early buyers across launches | Numbers withdrawn by the authors in an October 2026 correction ("buyer records include sell transactions and miss many buys") | Do not use the numbers; method idea only |
| [arXiv 2609.10246](https://arxiv.org/abs/2609.10246) (Meme Coin Factories) | Names five manipulation classes (wash trading, creator address obfuscation, coordinated sell, copycats, social media); methods not on the abstract page | None extracted | Abstract only |

Gaps: I found no published, validated threshold for "bundle %" or "sniper %" on pump.fun migrators, and no paper measuring post-migration drawdown of migrators other than MELT's 20-minute label. Time-to-migrate is not established as a bot signal (Marino: very fast graduations do not change the curve); keep it as the existing "fast migrators" bucket (Round 3 Q17), not as a bot metric.

## 5. Metric table

"Pre-migration?" means computable from data that exists before the migration event.

| Metric | What it catches | Source | Cost | Pre-migration? |
|---|---|---|---|---|
| Creation-slot buy share (supply bought by non-creator wallets in the create slot and the next 2 slots) | Bundled launches, snipers | Chain: curve trades + tx slot (IDL `TradeEvent.user`, Mobula/Pine definition) | about 50 credits/token with gTFA | Yes |
| Clustered supply share (wallets sharing a first funder, a co-purchase tx, or a Jito tip pattern; clusters of 3 or more) held at migration | Insider wallet clusters, bundles | Chain (MELT method), or RugCheck `insiderNetworks` as a cross-check | about 60 credits/token; RugCheck free | Yes (compute from trades). RugCheck: only if called before migration |
| Top-10 holder share at migration, excluding curve and pool | Concentrated dumpable supply | Chain (rebuild balances) or `getTokenLargestAccounts`; RugCheck `topHolders[].pct` | 1-2 credits to about 0 extra | Yes |
| Creator share at migration, and creator sells before migration | Dev dump | Chain (`TradeEvent.creator/user`) | Included in trade pull | Yes |
| Unique buyer wallets and (buyers / buy trades) | Few wallets making many trades (wash) | Chain | Included | Yes |
| Wash proxy: share of volume from wallets with both buys and sells and a round-trip ratio 0.9-1.1 | Wash volume | Chain; method from Bitquery blog | Included | Yes |
| Post-migration lowest price in first 20 min vs migration price | Outcome (bot dump), not a filter | Chain pool trades, or DexScreener `priceChange` windows as a crude proxy; MELT label | 20-min price needs pool trades: more RPC (not costed) | No (it is the validation label) |
| DexScreener avg trade size, buy/sell skew, `boosts.active` | Weak wash and paid-promotion hints | DexScreener | $0 | No (pair exists only after migration) |
| RugCheck `graphInsidersDetected`, `insiderNetworks`, `risks` | Insider graph, vendor risk flags | RugCheck | $0, 15 per window (unspecified) | Yes only if called pre-migration; else hindsight |
| Mobula bundler/sniper/insider holdings | Same, vendor-computed | Mobula | Price not verified | Unknown (not tested) |

## 6. Recommended "organic migration" filter (hypotheses to calibrate)

A migration is "organic" only if it passes all five. Starting thresholds are guesses anchored on the cited vendor numbers and MELT; none is validated on pump.fun migrators. Calibrate on our own data: pick cut-offs so that the dropped group has the largest post-migration drawdown and seller-concentration in the 7-day Cohort, and re-check on a later Cohort (same rule as the 3b gate).

1. Creation-slot supply share (non-creator wallets, create slot + 2): organic if under 10% of supply. (Mobula flags snipers at 20% combined; Pine says over 50% of launches have some creation-block buy, so use a share, not a yes/no.)
2. Clustered supply (3 or more wallets with a shared funder, shared co-purchase tx, or same Jito tip pattern; excluding CEX funders) at migration: organic if under 20% of supply. (MELT: bundled accounts hold 36.5% of supply on average in a dump-heavy sample; Mobula red at 10+ wallet networks.)
3. Top-10 holder share at migration, excluding curve and pool: organic if under 40%. (Mobula: under 30% healthy, over 50% red.)
4. Creator at migration: holds under 5% of supply and has not sold more than 50% of the creator's bought amount. (Mobula dev under 5% healthy.)
5. Unique buyer wallets before migration: at least 100, and no more than 30% of volume from wallets with round-trip ratio 0.9-1.1. (MELT excludes tokens under 100 holders; Bitquery wash signals; the 30% is a placeholder with no source.)

Do not add time-to-migrate. Keep the "fast migrators" bucket from Round 3 Q17 separate.

How it plugs into the Study: store the five numbers as Snapshot fields so the bot-driven group becomes a labelled stratum (or a confounder axis) and the Playbook does not learn lessons from it. This does not delete data: record the flag, learn from the organic stratum, and compare the two.

## 7. Cost summary

- Helius Developer: $49/mo (Free is borderline, depends on gTFA access on Free, not verified).
- RugCheck: $0 (rate limit 15 per unstated window; paid keys exist, price not found).
- DexScreener: $0.
- PumpPortal free streams: $0. Do not use the metered trade streams.
- Total: about $49 of the $100, leaving room for the X capture and Claude runs.

## 8. Biggest unknowns

1. Whether any of the thresholds above separates dumpers from survivors among migrators. The only quantitative validation I found (MELT) is on a different population and label, and the 2607.02795 numbers were withdrawn. Calibration on our own Cohort is the real answer.
2. Whether gTFA is included on Free, and the real credit cost of funding traces (my estimate assumes 20 early buyers and about 2 calls each).
3. RugCheck's ToS, paid pricing, rate-limit window, and the unschematised report fields (taken from one response; may change). Same for Mobula pricing, GMGN access, and Birdeye (docs pages did not load for me).
4. Jito bundle identification by signature: no documented route; the tip-account proxy is my inference and the tip-account list is not verified here.
5. PumpPortal migrate scope and payloads (already open in `cos.md` Round 3 note); migration time should come from the chain.
6. Direction of `isBot` in Marino et al.: that paper links more non-bot trade to more graduation, so "some bots" may be part of how tokens graduate at all; the filter targets coordinated supply control, not any bot activity.
