# 03: Research page with Picks
**Model:** sonnet / medium — a new War Room page and a table, one DexScreener lookup; no model call.

**What to build:** A new War Room page, **Research**. The Operator pastes one or more coin contract addresses (CAs), with an optional reason and an optional topic. Argus looks each coin up on DexScreener and records a Pick with a snapshot taken at that moment: name, ticker, market cap, liquidity, age and whether it has bonded. The page lists the Picks, newest first. A bad or unknown CA is reported on its line and does not stop the others. Pasted text is untrusted: it is shown escaped and never reaches a model uncleaned.

**Blocked by:** None

**Status:** ready-for-agent

- [ ] The page `/research` exists and is linked from the War Room navigation; pasting two valid CAs records two Picks with their snapshots (tested with a fake DexScreener).
- [ ] A malformed CA, an unknown CA, a CA with no pair and a DexScreener failure each give a plain message on that line and record nothing for it (tests); a failure does not lose the other lines.
- [ ] The same CA picked twice inside 24 hours is refused the second time with the reason; after 24 hours it is a new Pick (tested).
- [ ] Reason and topic are cut to a length limit, flattened and rendered as escaped text; a hostile reason with markup or a forged boundary line stays one escaped line (render test).
- [ ] The Pick time is the moment of recording, stored, and never changed afterwards (test that an update is refused).
- [ ] Render check with `pnpm page:check /research` at 1240 and 390 px; keyboard: focus the form, submit with Enter.
- [ ] Type-check, `pnpm lint` and `pnpm check` are green.

## Comments
