# 02: Safe links everywhere in the War Room
**Model:** sonnet / medium — mechanical routing of known sites plus one small lint rule; the lint rule is the part that needs care.

**What to build:** every link the War Room renders from stored or fetched data (a Signal's `url`, a Proposal's `previewUrl`, evidence links) goes through `safeHttpUrl`, so a `javascript:` or `data:` URL (or one with credentials) from a source never becomes a clickable `href`. A lint rule then bans a raw bound `:href` outside the safe helper or component, so the mistake cannot come back (pit of success).
Origin: the ticket 21 reviewer (2026-11-11) found `safeHttpUrl` sound but noted the same risk was already live elsewhere; the Operator approved this follow-up the same day.

Known raw sites (line numbers as of `main` bea79ca; re-grep `apps/warroom` for `:href` and `v-bind:href` rather than trusting them):
- `apps/warroom/app/pages/narratives/[id].vue:69`: Signal `s.url` straight into `:href` (and `:title`).
- `apps/warroom/app/pages/index.vue:262` (was :259 on the reviewed branch): Signal `s.url` straight into `:href`.
- `apps/warroom/app/components/UrlLink.vue:7`: renders any `href`. Its callers are `previewUrl` (`index.vue`, `proposals/[id].vue`) and evidence `link` (`proposals/[id].vue`). The simplest fix is to make `UrlLink` itself call `safeHttpUrl` and render the URL as plain text when it returns null; then every caller is covered.

`safeHttpUrl` is in `apps/warroom/app/utils/safe-link.ts` on branch `why-panel` (commit 04380ab, Phase 3 ticket 21): it returns the normalised href for an absolute http(s) URL without credentials, else null. Use it as is; do not write a second validator. Untrusted text stays rendered as text (`{{ }}`), never `v-html`.

**Blocked by:** Phase 3 ticket 21 (Why this Proposal panel) merging to `main`; `safe-link.ts` does not exist on `main` yet.

**Status:** ready-for-agent (once the blocker has merged)

**Lint rule:** extend the existing local plugin `config/oxlint/argus-plugin.js` (rule `argus/no-dynamic-regexp`, commits 9106faa and 8bff602) with a second rule, e.g. `argus/no-raw-href`, registered in `.oxlintrc.json` at `error`. Check first that oxlint lints `.vue` templates, not just `<script>`: if it does not, the rule must be a small repo script or test that scans `apps/warroom/**/*.vue` templates, wired into `pnpm lint` or `pnpm check`; say which in Comments. The rule flags a bound `:href` / `v-bind:href` (also `:src`-style link attributes if cheap) unless the bound expression is a call to `safeHttpUrl` or a value derived from it in the same component, or the file is the one safe component. Static `href="https://..."` is fine. Tests are exempt as for the existing rule. Reviewers reject any disable of the rule that lacks a one-line reason.

- [ ] Every site above renders its link only when `safeHttpUrl` returns a URL; otherwise the text shows without a link (no `href` attribute at all)
- [ ] `UrlLink.vue` validates internally, so no caller can pass an unsafe href through it
- [ ] Render tests (beside `apps/warroom/server/test/why-panel.test.ts`) at each fixed site, one `javascript:alert(1)` and one `data:text/html,...` URL each: no `<a>` with that `href` appears, the text still shows, and a normal `https://` URL still renders a working link with `rel="noopener noreferrer"`
- [ ] A URL with credentials (`https://user:pw@host/`) is not linked at any site
- [ ] The lint rule exists, is in the lint config, and the lint passes on the current tree
- [ ] Lint bite: a fixture or test shows the rule fails on a raw `:href="x"` (and `v-bind:href`) and passes on a `safeHttpUrl`-derived one and on `UrlLink`; the bite fails first (before the rule exists) and passes after
- [ ] `docs/agents/worker-rules.md` gets one line: War Room links from stored or fetched data go through `safeHttpUrl`; `pnpm lint` rejects a raw bound `:href`
- [ ] Full test suite, type-check and lint pass once before the commit

Out of scope: redesign of how links look; links in the Telegram or Slack notifications (separate surface, not rendered by the War Room); changing `safeHttpUrl` itself.
