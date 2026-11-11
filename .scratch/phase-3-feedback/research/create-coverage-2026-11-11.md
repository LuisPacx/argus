# Create coverage: PumpPortal ingest vs Dune (2026-11-11, read-only)

## Verdict
We drop no creates in code. The ~2/3 gap is upstream of our parser: PumpPortal's `subscribeNewToken` delivers about 14k creates/day, Dune counts 35-49k. Most likely PumpPortal does not emit every pump program create (undocumented); a smaller part is Dune counting more than "pump.fun creates". Not proven; the RPC check in section 5 settles it.

## 1. Our create rate (DB .data/argus.db, study_tokens.created_at = receipt time)
- Full day 2026-11-10: 13,810 creates. 2026-11-09 (data from 00:54Z): 11,871 in ~23 h. 11-11 so far 1,583 (downtime 02:39Z to 13:51Z, study_gaps id 10 reason restart).
- Hourly range on live hours: 240 to 922/h (trough 06-11Z ~250-450, peak 13-21Z 700-920). No hour near 0 except inside the restart gap (11-11 03Z-12Z absent, 13Z=74 partial).
- The 9 'disconnect' gaps (study_gaps 1-9) last 2 to 25 s each (about 1 min total): they cost ~10 creates, nothing visible hourly.
- Excluding downtime the rate is ~13.8k/day (~575/h average), i.e. ~39% of Dune's 35,077 for 11-08.
- Pool mix of creates: pump 25,730, bonk 1,531 (5%, LetsBonk launchpad, not the pump program, so Dune excludes them), so pump-only is ~13.1k/day.

## 2. Code drops (none found)
- packages/core/src/sources/pumpportal.ts:179 subscribes only `subscribeNewToken` + `subscribeMigration`; no sampling.
- :261-263 parse: keeps `txType` create/migrate with a base58 mint (:16); rejects only non-JSON, acks, bad mints. A create with a bad mint would be dropped; unlikely.
- :233 messages >16 KiB drop the connection (resets; none logged: grep "too large" in .data/run/worker.log gives 0).
- :246-250 MAX_BUFFERED=500 trims only the Signal buffer (poll every 5 min); the Study feed (`emitToken` :243, apps/worker/src/main.ts:204) is called before and independent of the buffer.
- packages/core/src/study/store.ts:299-310 `recordTokenEvent`: every create is INSERT OR IGNORE (dedupe on mint only). pool != pump or empty uri get status out-of-scope but are still stored and counted. No cap, no filter before storage.
- DB cross-check: 28,154 rows = 27,261 creates + 893 migrate-only rows (store.ts:316-318).

## 3. PumpPortal docs (https://pumpportal.fun/data-api/real-time/)
- Says only: `subscribeNewToken` "For token creation events. (Free)". No statement of coverage (all creates or not), launch modes, filters or sampling. Page gives no numeric rate limit (points to an FAQ).
- One websocket connection only; many connections can be timed out; bans expire hourly. We hold one (pumpportal.ts:195-198 logs open=1). Free for newToken/migration; trade/account streams cost 0.01 SOL per 10,000 events and need key + wallet >= 0.02 SOL.
- So the docs neither confirm nor rule out missing creates. Not verified: PumpPortal FAQ page, whether Token-2022/"mayhem"/create_v2 launches are emitted (hypothesis only).

## 4. Dune side (SQL as recorded in dune-2026-11-11.md "Browser check")
- Query 4861426: creates = COUNT per day of `MIN(block_time)` per `token_mint_address` from `tokens_solana.transfers`, action 'mint', `outer_executing_account` = pump program 6EF8r...F6P. Graduations from `solana.instruction_calls` by discriminator (785 on 11-08; ours ~800/day matches).
- Inflation possible but unproven: it counts any first mint whose outer executor is the pump program, not a `create` instruction. Includes every launch the program makes (including Token-2022/mayhem variants if PumpPortal skips them), and any wrapper/router that invokes pump as inner would be excluded, not added. It is bounded by the true chain count, so inflation beyond that is unlikely; recorded SQL lines 14-28 and 81-85 were not seen (filters there unverified).
- Consistency check: Dune graduation rate 2.2-2.4% of creates (34k vs 1.46M/month); ours 800/13.8k = 5.8%. If graduations are complete in both, our create denominator is ~2.5x too small, supporting a real undercount rather than Dune inflation.
- Our own data: of 1,632 migrations seen, only 739 have a create seen (893 'missed'). Partly explained by tokens created before T0 or during the 02:39-13:51Z gap; 593 of the misses migrated after 11-09 17:00Z. Graduators created within the window and missed would show direct undercount: suggestive, not conclusive.

## 5. Ranked causes and cheapest confirmation
1. PumpPortal stream is not the full pump create firehose (e.g. skips a launch variant or is sampled/lossy). Confirm: pick a closed 1 h window (e.g. 2026-11-10T14:00-15:00Z, we hold 914 creates), call Helius free RPC `getSignaturesForAddress` on 6EF8r...F6P (paginate with `before`/`until`, read-only per ADR 0002 Amendment), fetch the `create`/`create_v2` txs (`getTransaction` jsonParsed, filter logs "Program log: Instruction: Create"), count distinct mints, diff against study_tokens by mint. Cost: a few thousand signatures/hour; fits free tier if you sample 10-15 min (e.g. 14:00-14:15Z) and scale up. The diff also shows which variant is missing.
2. Dune counts more than create instructions (every first mint under the program, incl. variants PumpPortal skips; or unseen SQL filters). Confirm: same RPC pass gives the true chain count for the hour; compare with Dune's hourly if re-run, or with 11-08's daily figure scaled.
3. Our code drops: ruled out by reading (section 2). Confirm cheaply: count signatures in log/stream vs DB for 10 min via a temporary counter; not needed if 1 shows chain count >> ours with the missing mints absent from the wire.
4. Downtime/reconnects: negligible (~1 min of 9 disconnects; the 11-h restart is already excluded from the daily rate).

## Helius check (2026-11-11)

Free Helius tier, read-only RPC (getSignaturesForAddress 1 credit, getTransaction 1 credit; getTransactionsForAddress is 10+ credits so not used). About 1,200 credits spent of the 20,000 cap (546 for the 498 signatures + their txs, 496 re-fetching create args, plus ~110 on two aborted first runs); counted in-script, key never printed.

Method: getSignaturesForAddress on pump.fun's mint-authority PDA `TSLvdd1pWpHVjahSpsvCXUbgwsL3JAcvokwaKt1eokM`, window 2026-11-10T14:00:00Z to 14:15:00Z, failed txs dropped, then getTransaction (jsonParsed) for each. Create = the pump-program instruction whose accounts[1] is that PDA. Diff by mint against study_tokens.

Result:
- 498 successful signatures on the PDA; 496 creates (2 were CreatePool, not creates). All 496 distinct mints.
- Variant: 496/496 are `create_v2` (disc d6904cec5f8b31b4), Token-2022 mints, mint authority = that PDA. 482 direct, 12 via wrapper `CreateCoinAndBuyBondingCurveV3`, 2 via `CreateCoinAndBuyJupiterBondingCurve`. Zero legacy `create` (Token program) in the window.
- In study_tokens: 264 of 496 (53%); missed 232 (47%). study_tokens has 262 rows with created_at in the window, consistent. 496 per 15 min is ~47k/day, matching Dune's 35-49k. So the gap is PumpPortal not emitting, not Dune inflation, not our code.
- What the missed share depends on (all are create_v2, so variant alone does not split them). By create_v2 args (last two bytes decoded by position, no IDL: names are my reading of the pump create_v2 layout, unverified):
  - first arg byte after creator = 1 (likely `is_mayhem_mode`): 101 creates, 12 seen, 88% missed.
  - not mayhem (395): 252 seen, 36% missed (143). Within these, a trailing 1 (likely cashback flag) on the 16-account form: 39 creates, 3 seen, 92% missed.
  - Older-form creates (19-account, 2-byte args) 129/129 seen; 10-byte-args form 66/69 seen.
- By accompanying instruction in the same tx: BuyV3 48/48 missed, BuyExactQuoteInV2/V3 36 with 3 seen (92% missed), wrapper creates (V3, Jupiter) 14 with 1 seen, BuyV2 176 with 63% missed; BuyExactSolIn 138 with 1% missed, creates with ExtendAccount 151 with 5% missed.
- Reading: PumpPortal (or its source) appears to track only the older create_v2 shape (SOL-quoted buy via BuyExactSolIn/Buy, 19/20-account form). The newer shapes (mayhem, cashback flag, quote-mint-aware BuyV2/V3/ExactQuoteIn, creator-wrapped creates) are mostly not emitted. 57 of 496 mints lack the `pump` suffix; 53 of those are seen, so the suffix is not the cause.
- Caveats: one 15-minute window; flag meanings are inferred from byte positions, not from the IDL; the exact PumpPortal rule is not proven, only the correlation.

Fix idea: stop depending on subscribeNewToken for completeness; read creates from chain (poll getSignaturesForAddress on the mint-authority PDA, getTransaction for each, about 2 credits per create, ~100k credits/day at 48k creates/day so it needs a paid tier or a sampled/priority subset).
