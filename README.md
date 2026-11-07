# Argus

Argus watches public Sources, turns Narratives into Proposals (a token angle plus a Tech worth building), builds the approved ones unattended, and hands the Launch to the Operator in newpairspam. It researches, proposes and builds; it never launches tokens.

## Start here

- [`docs/architecture.md`](docs/architecture.md): purpose, diagrams, lifecycle, Build Runner, Brain, phases (section 12) and open questions.
- [`GLOSSARY.md`](GLOSSARY.md): the vocabulary (Signal, Narrative, Tech, Proposal, Spec, Build, Launch, ...). Use these terms.
- [`docs/adr/`](docs/adr/): decisions (Claude Code brain, newpairspam boundary, template build archetype).
- [`.scratch/cos.md`](.scratch/cos.md): the decision journal (local, gitignored); the source of truth for every agreed decision.

## Team board

[`docs/team/site/`](docs/team/site/) is a static, public page (https://argus-overview.pages.dev) that explains argus to the Team and seeds a "what next?" discussion. It holds no secrets; keep it that way.
Redeploy from a directory outside the repo: `npx wrangler pages deploy <path-to>/docs/team/site --project-name argus-overview --branch main` (needs `wrangler login`). Update the "Last updated" date first.

## Next step

Create the Phase 1 tickets with `/to-tickets` from [`docs/architecture.md`](docs/architecture.md) section 12 (tickets live under `.scratch/<feature>/`, see `docs/agents/issue-tracker.md`).

`memecoin-launch-pipeline-plan.md` is superseded by this documentation (its hard constraints live on as section 10 of the architecture) and can be deleted.

## Running argus

### Research (works today)

1. `pnpm install`
2. `pnpm models:fetch` (the embedding model, once; safe to rerun)
3. `pnpm dev:start` (starts the worker and the War Room)
4. Open the War Room at http://localhost:3100/ (logs: `.data/run/warroom-dev.log` and `.data/run/worker.log`)
5. `pnpm dev:status` / `pnpm dev:stop`

While argus runs, each process holds a `systemd-inhibit --what=handle-lid-switch:sleep --who=argus` lock, so closing the lid no longer suspends the machine. The lock is released when `pnpm dev:stop` runs or the process dies, and `pnpm dev:status` shows whether it is held. Without `systemd-inhibit` on PATH, argus still starts and prints a warning that sleep is not blocked.

Research uses your Claude subscription through `claude -p`, capped by `ARGUS_DAILY_QUOTA_USD` × `ARGUS_RESEARCH_SHARE` (defaults $20 × 0.3).

### Optional: Telegram

Set `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` in `.env`.

### Builds

1. Mint a Build token with `claude setup-token` and save it as one line in `~/.config/argus/build-token` (`chmod 600`, never committed).
2. `pnpm image:build` (rootless podman is required).
3. The worker deploys previews to a `<slug>.workers.dev` subdomain on your Cloudflare account.
4. `pnpm verify:contain` checks the containment.

### Launch

The Launch button opens newpairspam's token form prefilled. Set `ARGUS_NEWPAIRSPAM_URL` (default http://localhost:3000). `ARGUS_LAUNCH_LOGO_URL` is optional and must be a public raster image (newpairspam rejects SVG). argus never touches a chain; you launch in newpairspam and then mark the Proposal launched.
