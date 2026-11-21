/**
 * The Operator's last 20 research requests (human researcher ticket 05), newest first: the topic, the status (`pending`, `running`, `done`, `failed`,
 * `capped`), the reason in words, what the runs cost (from `brain_runs`) and the Research brief when there is one. Text from the model, from X, from web
 * pages and from DexScreener is untrusted: the page shows it as escaped text only. Read only.
 */
export default defineEventHandler(() => useStore().researchRequests());
