# Top-down sources for Solana memecoin leaders (research, 2026-11-16)

Calls made live today, no keys. GTA VI mint = 4kjruq... ($GTA6, about $7.1M FDV).

| Source | Endpoint | Auth / limit | "Trending" means | Fields | GTA6? |
|---|---|---|---|---|---|
| GeckoTerminal | GET api.geckoterminal.com/api/v2/networks/solana/trending_pools?page=1 (also ?duration=5m/1h/6h/24h, /pools?sort=h24_volume_usd_desc, /new_pools, /search/pools?query=) | none; public limit 30 calls/min (CoinGecko docs); 20 pools per page, max 10 pages | their ranking by recent tx/volume/traders (not paid) | fdv_usd, market_cap_usd (often null), reserve_in_usd, pool_created_at, volume m5/h1/h6/h24, tx counts, price change | YES, rank 10 of 20 (default duration), pool 1 of GTA6/SOL, liq 68k, vol24h 720k |
| Jupiter Tokens v2 | GET lite-api.jup.ag/tokens/v2/toptrending/{5m,1h,6h,24h}?limit=100, /toptraded/{interval}, /toporganicscore/{interval}, /search?query=<mint>, /recent | none on lite-api; header x-ratelimit shows a window of 5 calls (low, bucket reset about 10s); keyed api.jup.ag has higher limits | trending = Jupiter swap activity; toporganicscore = their anti-wash score | mcap, fdv, liquidity, holderCount, organicScore, stats5m/1h/6h/24h (volume, buyers, price change), firstPool.createdAt, audit | YES: toptrending/1h rank 13 of 50; toptraded/1h rank 65 of 100; NOT in toporganicscore/1h top 100. search gave mcap 7.04M, liq 272k, organicScore 72.9 |
| DexScreener | token-boosts/top/v1, token-boosts/latest/v1, token-profiles/latest/v1 (60 rpm); tokens/v1/solana/{mints}, latest/dex/search?q= (300 rpm) | none | Only paid boosts and profiles. No trending or top-by-mcap endpoint in the official API | marketCap, fdv, liquidity.usd, volume, pairCreatedAt | NO in boosts top (30). Reachable only by mint or search: 5 GTA6 pairs, marketCap 7.05-7.15M |
| CoinGecko | GET api.coingecko.com/api/v3/coins/markets?vs_currency=usd&category=solana-meme-coins&order=market_cap_desc&per_page=250 | none (demo/public about 5-15 calls/min, shared; free demo key 30/min); 200 OK | market-cap order (curated list) | market_cap, FDV, volume, price change | NO: 250 returned, down to $215k, GTA6 absent (listing lags; no new tokens). Good for established big caps (PENGU 309M, TRUMP, BONK, WIF, FARTCOIN) |
| Birdeye | public-api.birdeye.so/defi/token_trending | 401 without API key; free tier exists but trending is key-gated and low quota | rank by their volume/price/liquidity score | rank, liquidity, fdv/mc, volume | not tested (no key) |
| pump.fun | frontend-api-v3.pump.fun/coins/currently-live, /for-you, king-of-the-hill | Cloudflare challenge, HTTP 403 to plain curl | pre-graduation bonding curve only | n/a | not reachable. Unofficial API, ToS risk; and GTA6 is a bonk (letsbonk) launch on Raydium anyway, so it never appears there. Skip, or use PumpPortal websocket (third-party) |

## Other GTA-related tokens seen (GeckoTerminal search + DexScreener search)
- Same mint 4kjruq... has many pools (Meteora, Raydium, SOL/USDC/WASTED/BAWSAQ quotes): dedupe by base token, sum liquidity.
- GTA 6 Coin (EaxAUcXx) FDV 847k liq 112k; GTAVI (4nFLrVg1) 71k; GTAVI (25okNXRj) 61k; GTA6IRL 23k; others under 20k.
- TTWO/GTA6 pool (TTWofwAg, Take-Two tokenized stock) FDV 4.6M: real-world stock token, not a memecoin; filter.
- Fake: GTA6 mint EcLbZ6Zc... DexScreener marketCap 12.07B on 48.3M liquidity but 24h volume $2.28 (and a different 140k "GTA6" 2gVNeu8d).

## Minimum calls per 5-min tick (top-50 fresh)
- GeckoTerminal trending_pools: 20 per page, so 3 pages x (default + optionally 1h) = 3 calls. 
- Jupiter toptrending/1h limit=100: 1 call (returns up to 100 with mcap, liquidity, organicScore, stats). Add toptraded/1h: 1 call.
- Min viable: 1 Jupiter toptrending (50-100) + 3 GeckoTerminal pages = 4 calls per tick, 48 per hour, far under both limits. Add 1 CoinGecko call per hour for the established-cap list. Then 1 DexScreener tokens/v1 call (up to 30 mints) to cross-check market cap and liquidity for candidates.

## Gaming and defences
- Wash volume: trending and toptraded are volume-driven. Cross-check Jupiter organicScore (GTA6 was 73 medium; absent from toporganicscore top 100), buyers/holderCount, and volume/liquidity ratio.
- Paid boosts: DexScreener boosts/profiles are ads, not organic (already the current bottom-up source; it missed GTA6).
- Fake market cap on thin liquidity: the EcLbZ6 GTA VI shows 12B cap, 48M liq, $2 volume. Rules: require 24h volume >= some fraction of liquidity, mcap/liquidity ratio cap (e.g. under 200x, and real GTA6 is about 25x), cross-source mcap agreement (Jupiter mcap vs GeckoTerminal FDV within about 30%), holder count, token age. GeckoTerminal market_cap_usd is null for most memecoins, so use fdv_usd (equals mcap when supply is fully circulating).
- Single pool can be manipulated: aggregate per base token, take liquidity of the deepest pool, ignore stable/SOL/wrapped quotes and tokenized stocks.

## Recommendation (ranked)
1. Jupiter tokens v2 toptrending + toporganicscore (mcap, liquidity, organicScore in one call; no key).
2. GeckoTerminal trending_pools (3 pages) + new_pools: independent second opinion, free.
3. DexScreener tokens/v1 and search: only to verify candidates (not for discovery).
4. CoinGecko category: hourly, established leaders only.
5. Birdeye needs a key; pump.fun blocked and ToS risk: skip.
Raw responses were kept in the session scratchpad only. Ranks above are a single snapshot and move.
