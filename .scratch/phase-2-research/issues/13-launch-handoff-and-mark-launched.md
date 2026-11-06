# 13: Launch handoff and mark launched
**Model:** sonnet / medium — a handoff to another app plus one recorded action.

**What to build:** For a `built` Proposal, Launch opens newpairspam's token form prefilled with name, ticker, description, logo (the template SVG placeholder) and the preview link. The Operator launches in newpairspam, comes back, and marks the Proposal launched, recording the mint. Argus never touches a chain (ADR 0002).

**Blocked by:** Phase 1 ticket 07 (Build Runner happy path)

**Status:** done

## Prefill mechanism findings (newpairspam, read-only check)

No external prefill mechanism exists today: no query params, no pasted JSON.
- `apps/web/app/components/TokenForm.vue:14-23` the form fields are name, symbol, description, twitter, telegram, website, image (File), imageUrl.
- `TokenForm.vue:32-43` `onMounted` fills the form only from `deployerStore.restoreLastDeployment()` (the persisted last deployment), never from the URL.
- `apps/web/app/pages/index.vue:1-20` (the page hosting the form via `components/LaunchConsole.vue:725`) reads no route query. The only `route.query` uses in the app are `pages/login.vue:20` (`redirect`) and `plugins/referral.client.ts:6` (`ref`).
- `TokenForm.vue:~90-126` has a Helius import by existing mint address, which fills name/symbol/image from chain data. It cannot serve a not-yet-launched token.

Needed newpairspam change (not made; waits for the Operator's yes): in `TokenForm.vue` `onMounted`, read `useRoute().query` (`name`, `symbol`, `description`, `imageUrl`, `website`) and, when present, apply it over the restored values (then `router.replace` to strip the query). Query params fit the data: the logo is an SVG URL and the preview link goes into `website`. Argus side is then a link `${NEWPAIRSPAM_URL}/?name=..&symbol=..&description=..&imageUrl=..&website=<preview>`. Alternative: a paste-JSON box in the form (more UI, no URL length limit). Caveat: `imageUrl` is shown through `proxiedImageUrl`, so a data: or argus-hosted SVG URL must be checked.

Decision: the Operator chose query params and approved the change on a review branch. Done in newpairspam on branch `argus-prefill` (commit 13ec355a, worktree `.claude/worktrees/argus-prefill`, not pushed, main untouched): `app/utils/launchPrefill.ts` (`parseLaunchPrefill`: strings only, first of an array, name 32 / symbol 10 alphanumerics / description 500 caps, imageUrl and website must be http(s)), `TokenForm.vue` `applyUrlPrefill()` on mount (overrides restored values, strips the query with `router.replace`), test `apps/web/scripts/launch-prefill.vtest.ts`.

URL contract: `${ARGUS_NEWPAIRSPAM_URL}/?name=&symbol=&description=&website=<preview>[&imageUrl=<logo>]`. newpairspam's `nuxt dev` serves on port 3000 (no port override in its nuxt.config.ts or package.json), the default base URL.

Open: newpairspam's `/image-proxy` rejects SVG (415), and a local War Room URL is not reachable by it, so the template SVG placeholder cannot be the `imageUrl`. argus sends `imageUrl` only when `ARGUS_LAUNCH_LOGO_URL` is set to a public raster URL; otherwise the Operator uploads a logo in newpairspam (the form says so). Merging `argus-prefill` into newpairspam is the Operator's call.

Status: done.

- [x] The prefill mechanism of newpairspam's token form (query params or pasted JSON) is determined and recorded; any newpairspam change it needs is listed and made only with the Operator's yes
- [x] Launch is enabled only in `built`
- [x] Mark launched records the mint address (format validated) through the lifecycle
- [x] No wallet, chain or pump.fun call exists in argus (ADR 0002), enforced by a test
- [x] Endpoint-level tests with the exact UI payload
- [x] `pnpm check` passes
