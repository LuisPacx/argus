# Argus does not launch tokens: the newpairspam boundary

Status: accepted. Amended by the Phase 3 spec (2026-11-07): outcome tracking of argus's own Launches is read from chain automatically, read-only, and is no longer entered by hand (see Amendment). The boundary itself, no wallet and never launching, stands.

Argus researches, proposes, specs and builds. Token deploy, trading and PnL stay in newpairspam. The handoff is a Launch button that opens the newpairspam token form prefilled from the Proposal (name, ticker, description, logo, preview link), and a manual "mark launched" in the War Room where the Operator records the mint. Argus holds no wallet and no chain keys.

## Considered Options

- **Embed deploy in argus**: one tool end to end, but it puts wallet keys and spend authority into an agent-driven system that spawns unattended builds, and duplicates what newpairspam already does well.
- **Webhook or API back from newpairspam**: removes the manual "mark launched" step, but couples two deployables and needs auth between them; the manual step is a deliberate human gate. Auto-launch through a newpairspam API is explicitly out of scope, including in phase 3.
- **Fork helios (which has its own launcher)**: rejected earlier in favor of a new repo that reuses helios seams only.

## Consequences

- The only coupling is the prefill format. Whether it is query params or a JSON paste is an open question to check in newpairspam's `TokenForm.vue` before building the button.
- Launch status in argus is only as accurate as the Operator's "mark launched", which supplies the mint. ~~Outcome tracking (phase 3) is entered by hand too.~~ Superseded by the Amendment: outcomes are read from chain.
- The old plan's generator, deployer, promoter, position manager and ledger are out of scope for this repo.

## Amendment (Phase 3 spec, 2026-11-07)

Once the Operator has marked a Proposal launched with its mint, argus reads that mint from chain on its own (whether the curve completed, the migration, market data at 1h, 24h and 7d) and shows the outcome on the Proposal. At the 7d label argus closes the Proposal itself with the outcome; own Launches are kept out of the Study's Cohort statistics. This is read-only: public RPC and public market APIs, no wallet, no keys, no transaction. Argus still never launches, still holds no chain keys, and auto-launch through a newpairspam API stays out of scope. The mint still comes from the Operator's manual "mark launched"; argus does not discover Launches by watching wallets. Why: hand-entered outcomes would be rarely filled in and late, and the Phase 3 Study reads the same chain data for other tokens anyway. See `.scratch/phase-3-feedback/spec.md`, section 11.
