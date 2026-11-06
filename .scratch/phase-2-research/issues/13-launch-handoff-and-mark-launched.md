# 13: Launch handoff and mark launched
**Model:** sonnet / medium — a handoff to another app plus one recorded action.

**What to build:** For a `built` Proposal, Launch opens newpairspam's token form prefilled with name, ticker, description, logo (the template SVG placeholder) and the preview link. The Operator launches in newpairspam, comes back, and marks the Proposal launched, recording the mint. Argus never touches a chain (ADR 0002).

**Blocked by:** Phase 1 ticket 07 (Build Runner happy path)

**Status:** ready-for-agent

## Prefill mechanism findings (newpairspam, read-only check)

No external prefill mechanism exists today: no query params, no pasted JSON.
- `apps/web/app/components/TokenForm.vue:14-23` the form fields are name, symbol, description, twitter, telegram, website, image (File), imageUrl.
- `TokenForm.vue:32-43` `onMounted` fills the form only from `deployerStore.restoreLastDeployment()` (the persisted last deployment), never from the URL.
- `apps/web/app/pages/index.vue:1-20` (the page hosting the form via `components/LaunchConsole.vue:725`) reads no route query. The only `route.query` uses in the app are `pages/login.vue:20` (`redirect`) and `plugins/referral.client.ts:6` (`ref`).
- `TokenForm.vue:~90-126` has a Helius import by existing mint address, which fills name/symbol/image from chain data. It cannot serve a not-yet-launched token.

Needed newpairspam change (not made; waits for the Operator's yes): in `TokenForm.vue` `onMounted`, read `useRoute().query` (`name`, `symbol`, `description`, `imageUrl`, `website`) and, when present, apply it over the restored values (then `router.replace` to strip the query). Query params fit the data: the logo is an SVG URL and the preview link goes into `website`. Argus side is then a link `${NEWPAIRSPAM_URL}/?name=..&symbol=..&description=..&imageUrl=..&website=<preview>`. Alternative: a paste-JSON box in the form (more UI, no URL length limit). Caveat: `imageUrl` is shown through `proxiedImageUrl`, so a data: or argus-hosted SVG URL must be checked.

Status: blocked on the Operator's decision; no argus code written.

- [ ] The prefill mechanism of newpairspam's token form (query params or pasted JSON) is determined and recorded; any newpairspam change it needs is listed and made only with the Operator's yes
- [ ] Launch is enabled only in `built`
- [ ] Mark launched records the mint address (format validated) through the lifecycle
- [ ] No wallet, chain or pump.fun call exists in argus (ADR 0002), enforced by a test
- [ ] Endpoint-level tests with the exact UI payload
- [ ] `pnpm check` passes
