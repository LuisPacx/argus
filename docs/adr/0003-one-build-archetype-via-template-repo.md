# One Build archetype: a Cloudflare Workers web app from a template repo

Every Build starts from `argus-build-template`, a repo that bakes in a Cloudflare Workers web app skeleton, the `/implement-spec` skill, lint, CI and the creator disclosure footer. The Build Runner clones it into `~/code/<slug>`, writes the Spec in, and lets `claude -p` implement it unattended; the preview deploys to `<slug>.workers.dev`. A Spec that requires anything outside this archetype, such as an on-chain program, moves the Proposal to `needs-human` instead of attempting the Build.

## Considered Options

- **Free-form builds (agent picks stack and scaffolds)**: maximum flexibility, but unattended 1 to 4 hour runs with an unconstrained stack fail more often, cost more, and cannot guarantee lint, CI, deploy path or disclosure. The template makes success rate and cost predictable.
- **Several archetypes now** (web app, bot, CLI, on-chain program): premature; one archetype covers the first Techs (e.g. a launchpad-style web app). More archetypes can be added later as additional templates keyed on the Spec.

## Consequences

- Buildability on the Rubric is a hard gate, defined relative to this archetype.
- Some interesting Techs will be routed to `needs-human` and built by the Operator by hand (tmux, `claude --resume`).
- The template is a second repo with its own maintenance; changes to it affect all future Builds, not past ones.
