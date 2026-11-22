# 04: Coin-side trace and the taken check
**Model:** sonnet / medium. Plain code over the existing read-only DexScreener client. The care is in the rules (liquidity, not headline cap) and in never reading "no answer" as "open".

**What to build:** for each judged Moment, on every scan while it is live, search DexScreener for its phrases, class every matching Solana pair as a real clone or a lookalike, and give the Moment a coin-side state: `open`, `contested` or `taken`. The page shows the state, the biggest real clone, the lookalikes with their reasons, and when the state last changed. Useful alone: the Operator no longer checks DexScreener by hand, and the Boomazoom mistake (a drained $131K curve read as taken) cannot repeat.

Status: wontfix

**Blocked by:** 03
The judge's search phrases (ticket 03) are what the trace searches with.

## Evidence

- Manual rule: `.scratch/moment-scanner/spec.md` section 5; the scan notes drop an idea when "a clone is above $50K".
- The mistake it prevents: `.scratch/research/gta6-naming-lessons.md` section 1. At 13:08 two Meteora DBC coins showed $131.7K and $130.5K (`2EotBtrhJ4gZ8rtefQMefVoUNEv7B7nk9aYQ6YvbxNp3`, `4ttTPw125RPG3fUtAiTrJFctLrGkuTNJdpMZL2awhMNU`); their post-graduation pools held about $2 to $4 and price -100 percent; the real coins were $2K to $4K.
- Related code: `packages/core/src/meta/topdown.ts` (`fakeTestFailures`, `verifyAgainstDex`; Meta ticket 14's `unpriced` pairs), `packages/core/src/sources/dexscreener.ts` (`search`, with retry and backoff), `packages/core/src/collision.ts`. Do not reuse the Meta's $50,000 liquidity floor: it would call every early clone a lookalike. Moment floors live in `moments/config.ts`.

## Design

- **Candidates:** for each phrase (from ticket 03, at most 4) one `DexScreenerClient.search`, at most 10 searches a scan across Moments (Moments with the oldest trace first). Keep Solana pairs whose name or ticker matches: every word of a phrase is in the normalised name, or the ticker equals the phrase with spaces removed. Only pairs created at or after the Moment's earliest post count as clones; older matches are listed as `older coin` and never change the state (the naming check in `meme-ideas` still refuses a copy of any name).
- **Real clone:** priced (not `unpriced`), liquidity at least $5,000, market cap (or FDV when no cap) at most 100 times liquidity. Everything else is a **lookalike** with a reason string ("liquidity $4 under $5,000", "cap 32,900x liquidity", "unpriced"). A cap and liquidity of the same pair come from the same answer.
- **State:** `taken` if any real clone has a cap of $50,000 or more, `contested` if there are real clones and none reach it, `open` if there are none. A Moment whose search failed keeps its last good trace marked "not traced at <time>"; with no earlier trace it is "not traced". Never `open` on a failure.
- **Store:** `moment_traces` (Moment, scanned at, state, clones as JSON with name, ticker, mint, pair link, created at, liquidity, cap, volume, class and reason). Append only; state changes and the first time a real clone reached $50,000 (pair creation time and the time the scan saw it) are columns, read by ticket 07.
- **Live window:** a Moment is traced while qualifying or rising and for 24 hours after its last flag.

## Acceptance criteria

- [ ] **Classifier** (`trace.test.ts`): a pair with $4 liquidity and a $131K cap is a lookalike ("liquidity $4 under $5,000"); the two mints above, built into the test as pairs with those figures, are lookalikes and the Moment is not `taken` by them; $6K liquidity and a $700K cap (117x) is a lookalike, and $6K with a $500K cap (83x) is a real clone and `taken`; $20K liquidity with a $60K cap is a real clone and `taken`; a $40K cap with $8K liquidity is real and `contested`; no pairs is `open`; an `unpriced` pair is a lookalike and is never read as 0; a pair with FDV only uses the FDV; a pair created before the Moment's earliest post is `older coin` and changes nothing.
- [ ] **Matching** (`match.test.ts`): "jet ski dog" matches "The Jetski Dog" and ticker JETSKI by the squashed rule, not "Jet Setter"; "hulk" matches HULK and "Hulk Smash" and does not match "Hulkster" (whole words, not substrings); case, punctuation, `$` and emoji are normalised; no RegExp is built from a phrase or a name.
- [ ] **Pass** (`trace-pass.test.ts`, fake DexScreener from recorded-shape fixtures): a failure keeps the last trace and marks it stale and never produces `open`; a malformed answer (no `pairs` array) is a failure, as `search` already throws; the 10-search cap is held and the oldest trace goes first; a state change is recorded once with its time; the first $50K real clone time is set once and never moves.
- [ ] **Replay of the notes** (`trace-notes.test.ts`, pairs transcribed from `gta6-naming-lessons.md` section 1 and section 4, labelled transcribed): the scooter Moment at 13:08 is `open` or `contested` (not `taken`), with the two DBC coins as lookalikes; Hulk at 15:25 is `contested` (3 coins at $18K to $23K); alien at 15:25 is `contested` (AL $26K); the Mandy Moment at 08:04 is `taken` (`$MANDY` at $194K; the scan notes record it as dropped for that reason; give the test pair real-looking liquidity and say so, since the notes give no liquidity figure).
- [ ] **Page** (`moments-render.test.ts`, `pnpm page:check --seed /moments`, seeded): the state on each row, the biggest real clone with its figures and a DexScreener link (only `https://dexscreener.com/solana/<mint>` through `safeHttpUrl`), the lookalikes in a collapsed list with reasons, "taken since <time>"; hostile token names escaped; no overflow at 390 or 1240 px.
- [ ] Type-check, `pnpm lint` and the full `pnpm check` pass, run once before the commit.

## Constraints

- Read-only DexScreener only, through the existing client and its backoff; no pump.fun API (Cloudflare 403), no wallet, no chain call. Names and tickers are third-party text: cleaned and cut, never a pattern.
- Commit subject `Moment scanner ticket 04: coin-side trace and the taken check`, body ends with `Ticket: .scratch/moment-scanner/issues/04-coin-side-trace-and-taken-check.md`.

## Comments
- 2026-11-21 cos triage: ADR 0009, the Operator researches; the automatic moment loop stays off (ARGUS_MOMENTS)
