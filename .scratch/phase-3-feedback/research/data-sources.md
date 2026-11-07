# Phase 3 learning loop: data sources

Researched 2026-11-07. Terms follow `GLOSSARY.md` (Signal, Source, Rubric, Proposal, Tech). Nothing was run against the repo's toolchain; only public docs, public IDLs and a few single HTTP requests were used. "Not verified" marks anything I could not confirm from the owner of the claim.

Scale assumed: about 100 studied tokens per day (about 3,000 per month), each with a website fetch, an X account read, a read of its recent posts and a search for its ticker.

## Recommendation

| Source | What it gives | Cost/month at our scale | ToS risk | Use? |
|---|---|---|---|---|
| PumpPortal `subscribeNewToken` / `subscribeMigration` (already in `packages/core/src/sources/pumpportal.ts`) | Live create and migrate events, forward only | $0 | Low. Free streams documented; one connection only | Yes (the spine) |
| Solana RPC on the pump program, via Helius Free or Developer | Ground truth: `BondingCurve.complete`, `CompleteEvent`, `CompletePumpAmmMigrationEvent`, `CreateEvent.uri`; label every created mint | $0 (Free, 1M credits) to $49 (Developer) | Low (standard RPC) | Yes |
| Token metadata JSON at `CreateEvent.uri` (IPFS) | name, symbol, description, image, `website`, `twitter`, `telegram` | $0 | Low | Yes |
| DexScreener API | Price, market cap, pairs, `pairCreatedAt` for a mint, for post-migration snapshots | $0 | Low to medium; no terms found on the docs page | Yes, as a snapshot helper only |
| pump.fun `frontend-api-v3.pump.fun` | `complete`, `usd_market_cap`, `pump_swap_pool`, `created_timestamp`, lists | $0 | Medium to high: undocumented, behind a Cloudflare challenge (HTTP 403 from here), ToS not read | No (RPC gives the same, signed by the chain) |
| Bitquery | Pump/PumpSwap queries, graduation marker | $0 to $29 trial and personal (non-commercial); $69 Pro | Low; Personal plan is non-commercial only | No (history too short on self-serve; see below) |
| Dune | Historical cohorts for base rates | $75 Analyst for API | Low | No for pipeline; maybe one-off, free to read dashboards |
| Birdeye | New listings (with `meme_platform_enabled`), meme list | $39 to $199 | Low | No (duplicates PumpPortal + RPC) |
| X API official, pay-per-use | Account, posts, ticker search | about $330 to $630 (see section 2) | None (the only ToS-safe route) | Only for a tiny sample or later |
| Third-party X API (twitterapi.io etc.) | Same data via scraping vendor | about $20 | Medium to high (see section 2) | Yes for a pilot, with eyes open |
| Cloudflare Browser Run (was Browser Rendering) | Rendered HTML, markdown, screenshot, `/snapshot` | $0 to about $5 (Workers Paid; the $5 base price is from memory, not re-verified) | Low; self-identifies | Yes |
| Plain HTTP fetch for static sites | HTML | $0 | Low | Yes, first try before the browser |
| archive.org Wayback (availability, CDX, Save Page Now) | Dead-site fallback, and the snapshot as it was | $0 | Low; rate limits not documented on the page | Yes |

Recommended stack: PumpPortal (create + migrate stream) + Helius Free RPC for labels and chain truth + metadata URI + DexScreener snapshots + plain fetch with Cloudflare Browser Run fallback + Wayback + a third-party X API for the pilot. About $5 to $25 per month. Official X reads at this scale would be hundreds of dollars.

## 1. Migrated tokens and the control group

### 1.1 What "migrated" means on chain (primary: pump IDL)

Source: [pump-fun/pump-public-docs `idl/pump.json`](https://github.com/pump-fun/pump-public-docs/blob/main/idl/pump.json), program `6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P` (read from the IDL's `address`). I downloaded and parsed the IDL.

- `BondingCurve` account has a `complete: bool`, plus `real_quote_reserves`, `token_total_supply`, `creator`, `quote_mint`.
- Instructions `migrate` and `migrate_v2` are documented in the IDL as "Migrates liquidity to pump_amm if the bonding curve is complete". They need a `withdraw_authority` account and create the `pool` on `pump_amm`.
- Events: `CreateEvent` (name, symbol, `uri`, mint, creator, timestamp), `CompleteEvent` (user, mint, bonding_curve, timestamp, quote_mint), `CompletePumpAmmMigrationEvent` (mint_amount, sol_amount, `pool_migration_fee`, bonding_curve, timestamp, `pool`, quote_mint), `PostCompleteBuyEvent`.
- Two moments exist and they differ: the curve is marked `complete` on the buy that fills it (`CompleteEvent`), and the pool exists after `migrate` (`CompletePumpAmmMigrationEvent`). The README's "Synthetic migration" section says that after the filling buy "no buys or sells are possible on the curve until migration happens" ([README](https://github.com/pump-fun/pump-public-docs)). The glossary-level "migrated" in the repo's `pumpportal.ts` ("completed its bonding curve and moved to a swap pool") corresponds to the second. Decide which timestamp Argus records and store both.
- Market cap at migration is not a field. Derive it: price from the `CompletePumpAmmMigrationEvent` (`sol_amount` / `mint_amount`) times `token_total_supply`, times SOL/USD at that time. `quote_mint` now exists on all these events, so some curves may be quoted in a non-SOL mint; filter or convert.
- The curve threshold: the peer-reviewed-style study below describes it as 85 SOL real, 115 SOL total virtual including a 30 SOL virtual advance. The IDL page I read did not state the number; treat as a [secondary figure](https://arxiv.org/html/2602.14860v1).

### 1.2 Listing migrated tokens

| Option | How | Cost | Rate limit | History | Freshness | ToS |
|---|---|---|---|---|---|---|
| PumpPortal | `wss://pumpportal.fun/api/data`, `subscribeMigration` and `subscribeNewToken` | Free; token and account trade streams cost 0.01 SOL per 10,000 messages and need an API key and wallet | One connection only; abuse ban lasts 1 hour; no numeric limit published | None (forward only) | Seconds | Free streams documented. [PumpPortal real-time docs](https://pumpportal.fun/data-api/real-time/). The page does not list the migration payload fields (the repo already reads `txType === "migrate"` and `mint`). |
| Solana RPC (Helius) | Subscribe or poll the pump program; `getMultipleAccounts` on bonding-curve PDAs and read `complete`; decode events from transactions | Helius Free: $0, 1M credits, 10 RPC req/s; Developer $49, 10M credits, 50 req/s. `getProgramAccounts` 10 credits, `getSignaturesForAddress` 1, `getTransactionsForAddress` 10 per 100 txs ([plans](https://www.helius.dev/pricing), [credits](https://www.helius.dev/docs/billing/credits) via search summary) | 10 req/s on Free | Archival listed on all plans; depth not stated on the pricing page | Seconds | Standard use |
| pump.fun frontend API | `GET https://frontend-api-v3.pump.fun/coins-v2/{mint}` returns `complete`, `usd_market_cap`, `pump_swap_pool`, `metadata_uri`, `created_timestamp` (documented only in the local `create-coin` skill) | Free | Unknown | Per mint | Live | Undocumented for third parties; my one request got a Cloudflare "Just a moment..." challenge (HTTP 403). pump.fun's terms page returned 403 to every automated fetch (also via Wayback: none), so the ToS is **not verified**. Do not rely on it. |
| DexScreener | `GET https://api.dexscreener.com/token-pairs/v1/{chainId}/{tokenAddress}`, `/tokens/v1/...`, search; pair has `pairCreatedAt` | Free | 60 req/min on the profile/meta endpoints; not stated for the pair endpoints ([reference](https://docs.dexscreener.com/api/reference)) | Only what it indexes | Minutes | No terms on the docs page I read. No "list all migrated pump tokens" endpoint is documented. |
| Birdeye | `GET /defi/v2/tokens/new_listing` (limit 1 to 20, `meme_platform_enabled`), `GET /defi/v3/token/meme/list` (meme data from 2025-06-20) | Free tier is 3 endpoints, 1 rps; Lite $39, Starter $99, Premium $199, Business $499 on the main page, different numbers on another Birdeye page (pages conflict) ([pricing](https://birdeye.so/data-api/pricing), per search summary; my fetch of it returned 403) | 15 rps on Lite per summary | From mid-2025 for meme list | Seconds to minutes | Standard API terms (not read). I found no documented "graduated" filter. |
| Bitquery | GraphQL over `DEXPools`, marker `Base.PostAmount = 206900000` for graduation | Personal $29, Pro $69, Scale $199 per month; Personal is **non-commercial only**; 7-day trial with 1,000 points ([pricing](https://bitquery.io/pricing); the page contradicts itself on some prices) | 30 / 90 / 240 req/min | On-chain about 12 hours on self-serve Solana; trades about 30 days; older data needs an archive add-on or enterprise or Parquet files ([Pump.fun API docs](https://docs.bitquery.io/docs/examples/Solana/Pump-Fun-API/)) | Real time | Check commercial clause |
| Dune | SQL over Solana tables, API export | API needs a trial or paid plan: Analyst $75/mo for 4,000 credits, Plus $399/mo for 25,000 credits ([credit docs](https://docs.dune.com/learning/how-tos/credit-system), per search summary) | Plus: 200 API calls/min | Full history | Hours-level lag (not verified) | Standard |

Recommendation for the migrated list: record forward from today with PumpPortal, and verify each event against the chain (`complete`, pool). For backfill, only use a one-off Dune or Bitquery archive pull if the forward sample is too thin; do not pay monthly for it.

### 1.3 The control group (avoiding survivorship bias)

The biggest design trap is that "did not migrate" cannot be read off a snapshot at creation time. Two sources support this:

- Median time from creation to graduation is about 4.4 minutes (median 457 swaps) but the distribution is strongly right-skewed with a long tail ([arXiv 2602.14860](https://arxiv.org/html/2602.14860v1), 655,770 tokens, Sept 2025).
- A 2026 audit finds that an off-chain collector's `TIMEOUT` label "does not establish platform-side non-graduation", and its model's AUROC fell from 0.8594 (development) to 0.4642 (validation) on a 749,816-mint corpus, 12 May to 10 June 2026 ([arXiv 2607.02823](https://arxiv.org/abs/2607.02823)). Lesson: label from chain events, hold out in time, expect leakage.

Method that fits the stack:

1. Record every `CreateEvent` (PumpPortal create stream, free) with timestamp and `uri`. That is the full population, no survivors only.
2. Label each mint from chain: `BondingCurve.complete` (batch via `getMultipleAccounts`, 100 accounts per call, 1 credit per call per the Helius table) at fixed horizons (for example 1 h, 24 h, 7 d). Negative = not complete at 7 d (right-censored before that).
3. Sample controls from the same population at the same time (same creation hour or day), stratified on features known at creation (creator, early volume), not on outcome. Only study the Tech/site/X of a sampled subset, because those cost money (sections 2 and 3).
4. Snapshot website and X at a fixed age (for example creation + 10 minutes) for both groups, so features are measured before the outcome and equally for both. Snapshotting migrated tokens after migration leaks the outcome.
5. Base rate is below 1%, so a 1:1 sample is a deliberate oversample; keep the sampling weights.

### 1.4 Token metadata (name, ticker, description, website, X)

- `CreateEvent` carries `name`, `symbol`, `uri`. The `uri` points to a JSON document with `name`, `symbol`, `description`, `image`, and optional `twitter`, `telegram`, `website` ([local create-coin METADATA.md](file:///home/unknown/.claude/skills/create-coin/references/METADATA.md), also [raw upstream](https://raw.githubusercontent.com/pump-fun/pump-fun-skills/refs/heads/main/create-coin/references/METADATA.md)). Fetch from IPFS or whatever host the URI names. Public IPFS gateway rate limits were not checked.
- All fields are creator-supplied and untrusted: the repo's `pumpportal.ts` already strips markup and validates the mint; reuse that rule for URLs (`safeUrl`) before fetching anything (SSRF risk: never fetch private addresses).

### 1.5 What the pump SDK skills (`create-coin`, `swap`, `coin-fees`) give for reads

They are write-oriented but contain read helpers (local files under `/home/unknown/.claude/skills/`):

- `swap/scripts/fetch-coin.mjs` and `coin-fees/scripts/fetch-coin.mjs` call the undocumented `frontend-api-v3.pump.fun/coins-v2/{mint}` (fields above). The skill itself warns never to trust `token_program` from it and to read it from the mint account.
- `@pump-fun/pump-sdk` `OnlinePumpSdk.fetchBondingCurve(mint)` reads `complete` on chain; `fetchGlobal()` reads global config (used in `coin-fees` scripts and the `create-coin` skill).
- `POST https://fun-block.pump.fun/agents/swap` returns `pumpMintInfo.hasGraduated`, but needs a user pubkey and builds a trade transaction; it is not a read API for us and ADR 0002 says Argus holds no wallet or chain keys.
- Nothing there lists migrated tokens or history. Use the IDL events instead.

Fit with ADR 0002: everything above is read-only (a PumpPortal stream, RPC reads, public HTTP). No wallet, no keys, no launching. The one thing to avoid is the PumpPortal metered streams, which need a funded wallet; stay on the free ones.

## 2. X posts

### 2.1 Official X API (primary: [docs.x.com pricing](https://docs.x.com/x-api/getting-started/pricing), fetched today)

Pay-per-use, per resource returned: posts $0.005, users $0.010, followers/following $0.010, lists $0.005, DM events $0.010, owned reads $0.001, Counts: Recent $0.005 per request, Counts: All $0.010 per request, Trends $0.010 per request. Pay-per-usage plans are capped at 3 million Post reads per monthly billing cycle; higher volume needs Enterprise (no price shown). The page shows no subscription tiers and no dates. Same resource requested twice in 24 hours is charged once ([docs.x.com about-x-api](https://docs.x.com/x-api/getting-started/about-x-api)). Third-party blogs say the free tier closed to new signups around 6 to 9 February 2026 and that Basic ($200/mo) subscribers were migrated from June 2026; the primary page I fetched does not confirm that, so treat it as unverified.

Rate limits per 15 minutes ([rate-limits](https://docs.x.com/x-api/fundamentals/rate-limits)): recent search 450 per app, up to 100 results per request; user lookup 300 per app; user posts timeline 10,000 per app (username variant 1,500). These are not binding at 100 tokens per day.

The search-recent window (7 days) and spend caps were not on the pages I could read: not verified.

### 2.2 Cost at about 100 tokens/day

Per token: one user lookup ($0.01), one posts timeline read (N posts at $0.005), one ticker search (M posts at $0.005). Search has no listed price except per returned post; I assume it is billed as post reads.

| Depth per token | Per token | Per day | Per month (30 d) |
|---|---|---|---|
| 1 user + 10 posts + 10 mentions | $0.11 | $11 | $330 |
| 1 user + 20 posts + 20 mentions | $0.21 | $21 | $630 |
| 1 user + 5 posts + 5 mentions | $0.06 | $6 | $180 |

Dedupe in 24 hours does not help across distinct tokens. Most pump.fun tokens have no X account or a brand-new one, so real cost is likely below the table; and Argus only needs the sampled subset. If only the migrated plus a matched control sample (say 20 per day) is read: about $2 to $4 per day, $66 to $126 per month at 10+10.

### 2.3 Third-party X data APIs

- twitterapi.io: $0.15 per 1,000 tweets (15 credits each), profiles from $0.01 per 1,000 (18 credits each for 1 to 99 per call), minimum 15 credits ($0.00015) per call, $1 free on signup, credits expire after 31 days ([pricing page](https://twitterapi.io/pricing); QPS not stated). A token with 1 profile + 20 posts + 20 mentions is about $0.006 to $0.007; 100 tokens a day is about $20 per month. Other vendors are quoted by blogs at $0.05 to $0.40 per 1,000 tweets; vendor-reported, not checked.
- ToS risk: **X's own terms forbid it.** [X Terms of Service](https://x.com/en/tos) (fetched today): "You may not access the Services in any way other than through the currently available, published interfaces that we provide. For example, this means that, except as required by applicable law, you cannot scrape the Services without X's express written permission." Third-party vendors that do not use the official API operate on scraping, so they sit on the wrong side of that sentence and can vanish, get blocked or change pricing without notice. The legal and enforcement risk falls mostly on the vendor, but the dependency risk is ours. The X developer terms page needed payment to read (HTTP 402); AI-training restrictions in the X developer agreement were not checked.

What is ToS-safe, plainly: only the official X API on pay-per-use, with the data used within the developer terms. Scraping x.com directly, browser automation of x.com, and scraping vendors are not ToS-safe. Mitigation if using a vendor: keep it behind a thin Source adapter, store only derived features plus tweet ids, make it off by default, and treat X features as optional so the loop still works without them.

## 3. Websites

- Static first: a plain HTTP GET of the `website` URL (with the repo's `safeUrl` and a size and time cap) is enough for most memecoin sites; fall back to a rendered fetch only when the body is an empty app shell.
- Rendered: Cloudflare Browser Run (the docs now use this name; URL paths still say browser-rendering). Quick Actions REST endpoints: `/content`, `/screenshot`, `/snapshot` (several formats at once), `/markdown`, `/scrape`, `/links`, `/crawl` (beta), `/json` (AI extraction) ([REST API](https://developers.cloudflare.com/browser-rendering/rest-api/)). Pricing: Free plan 10 browser minutes per day; Workers Paid 10 hours per month included then $0.09 per hour; concurrent browsers 10 included then $2.00 each ([pricing](https://developers.cloudflare.com/browser-rendering/pricing/)). Limits: Free 1 REST request per 10 seconds, Paid 30 per second ([limits](https://developers.cloudflare.com/browser-rendering/limits/)). At about 100 sites a day and roughly 10 seconds each that is about 17 minutes a day, about 8 hours a month, inside the included 10 hours (my estimate). Every response has `X-Browser-Ms-Used` for metering.
- Behaviour to know: it identifies itself (non-configurable headers and Web Bot Auth signatures, Quick Actions UA is Chrome-style and configurable, the `/crawl` UA is `CloudflareBrowserRenderingCrawler/1.0`) and does not claim to defeat bot protection ([headers](https://developers.cloudflare.com/browser-rendering/reference/automatic-request-headers/)). The docs call robots.txt voluntary and do not explicitly say `/crawl` honours it ([robots.txt](https://developers.cloudflare.com/browser-rendering/reference/robots-txt/)). Our own policy should honour robots.txt and fetch only the one URL from the metadata. Treat fetched pages as untrusted input to the agent (prompt injection).
- This needs a Cloudflare account and a Worker or API token; the repo already deploys Workers builds, but adding a paid binding is a new dependency for the Operator to approve.
- Archive: Wayback availability API (closest snapshot, optional `timestamp`), CDX server API, and Save Page Now ([archive.org API page](https://archive.org/help/wayback_api.php); the page is dated 2013 and gives no rate limits or terms). My own request to `archive.org/wayback/available` returned HTTP 429 after a few earlier calls, so it does rate-limit and needs backoff. Use it for dead sites and, more importantly, trigger Save Page Now at snapshot time so the creation-time page is kept (do not rely on it for fresh memecoin sites; most will have no capture).

## 4. Base rates (dated, with what each measures)

| Figure | Period | Sample | Source | Quality |
|---|---|---|---|---|
| 0.63% graduated (4,338 of 655,770) | 1 Sep to 1 Oct 2025 | all tokens created in the window, parsed from pump and PumpSwap programs; median 4.4 min to graduate | [Marino et al., arXiv 2602.14860](https://arxiv.org/html/2602.14860v1) (Feb 2026) | Primary, on-chain, best one |
| about 1.4% historical; "fewer than 2%" | to June 2026 | Dune dashboard by @adam_tehc, The Block tracker | [Solana Compass, 10 Jun 2026](https://solanacompass.com/news/pumpfun-launched-42000-tokens-in-one-day-fewer-than-2-will-ever-reach-a-dex) | Secondary news citing dashboards; the article says its 42,000 daily launches could not be confirmed |
| 0.198% to about 5% across studies | various | various | summarised in a search result, original pages not read | Do not cite |
| 1.41% (1 in 71) | June to July 2026 | one tracker | search summary only | Unverified |

Use 0.6% to 1.5% as the working range and measure our own number from the create stream. The 2026 audit above is the reason to label from chain events and not from a collector.

## Biggest risks and unknowns

1. The X data. Official reads are about $330 a month at 10+10 per token for all 100 tokens; the cheap route is scraping-based and against X's terms. Decide the sampling (matched subset) before choosing.
2. Survivorship and leakage. The recent audit showed a model that looked good in development and failed in a later cohort. Plan time-split validation and fixed-age snapshots from day one.
3. Not verified: pump.fun's own ToS (403 to every fetch), the PumpPortal migration payload fields, Helius archival depth, IPFS gateway limits, Dune data lag, Birdeye's graduated filter, X developer terms on AI use, and whether the search-recent 7-day window still holds.
4. Chain format drift: the IDL now has `*_v2` and `*_v3` instructions and a `quote_mint`, so the "complete / migrated" logic must be re-read from the IDL when the program changes. Pin the IDL version used.
