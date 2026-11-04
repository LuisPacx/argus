# Claude Code headless is the brain, with the Anthropic API as fallback behind one interface

Argus runs its LLM work (judge, propose, spec, build) by spawning `claude -p` from a long-running worker, authenticated with a `claude setup-token` subscription token, so research and builds spend the Operator's subscription budget first. Everything goes through a single `Brain` interface with two backends (ClaudeCodeBrain, ApiBrain using the same skill markdown), and routing per task is config. When the subscription window is exhausted, `judge` and `propose` fall back to the API (haiku); builds never fall back, they wait.

## Considered Options

- **API only (pay-as-you-go)**: simplest and fully programmable, but cost is unbounded by a flat plan and builds (hours of agent work) are expensive. Kept as the fallback and as the day-one second backend, not the primary.
- **Claude Agent SDK**: equivalent power to `claude -p`, but adds a dependency and an API-billing posture without extra capability we need; spawning the CLI reuses skills, `--resume` and the subscription token directly.
- **Cloud scheduled tasks / routines**: minimum interval 1 hour (we need 5 and 30 minute ticks), each run clones the GitHub repo fresh with no local files (no access to `.data`, `~/code/<slug>` or tmux resume), and a network allowlist that blocks some news domains unless set to Full.
- **In-session cron**: only lives while an interactive session runs and expires after 7 days.

## Consequences

- Auth: `CLAUDE_CODE_OAUTH_TOKEN` (one year) must be rotated; `ANTHROPIC_API_KEY` must be unset in children or it overrides the subscription.
- Cost per run comes from `total_cost_usd` in the JSON output and is stored per Proposal. Max-plan numeric limits and whether `claude -p` keeps drawing from the subscription are unconfirmed (see architecture section 13); the interface exists so this risk is a config change, not a rewrite.
- Concurrent children share one rate limit with the Operator's own usage; research is capped to roughly 30% of the daily share so builds are not starved.
