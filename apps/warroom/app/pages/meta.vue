<script setup lang="ts">
// /meta: every Meta of the latest run with all the detail the home strip leaves out. The ranking, grouping and summary lines come from
// GET /api/metas; this page only displays them (see utils/meta.ts). The 6 h / 24 h toggle is a link, so the choice lives in the URL.
import { META_POLL_MS, metaView } from "../utils/meta.ts";

const route = useRoute();
const window = computed<"6h" | "24h">(() => (route.query.window === "6h" ? "6h" : "24h"));
const { data: metas, refresh: refreshMetas } = await useFetch("/api/metas", { query: { window, limit: 50 }, default: () => null });

const nowMs = ref(Date.now());
let metaTimer: ReturnType<typeof setInterval> | undefined;
let clock: ReturnType<typeof setInterval> | undefined;
onMounted(() => {
  metaTimer = setInterval(() => void refreshMetas(), META_POLL_MS);
  clock = setInterval(() => (nowMs.value = Date.now()), 30_000);
});
onBeforeUnmount(() => {
  clearInterval(metaTimer);
  clearInterval(clock);
});

const view = computed(() => metaView(metas.value, nowMs.value, { rows: 50, window: window.value }));
const windows = computed(() => [
  { label: "Last 24 h", to: { path: "/meta", query: {} }, active: window.value === "24h" },
  { label: "Last 6 h", to: { path: "/meta", query: { window: "6h" } }, active: window.value === "6h" },
]);
</script>

<template>
  <div class="grid gap-6">
    <div class="flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
      <h2 class="page-title">Meta</h2>
      <SegmentedLinks label="Ranking window" :options="windows" />
    </div>
    <p class="note muted">
      The themes the token market is launching around, ranked over the {{ window === "6h" ? "last 6 hours" : "last 24 hours" }}. Migrations are unfiltered (no bot filter);
      "after 60 s" counts only those that came more than a minute after the launch.
    </p>
    <MetaList :view="view" />
    <p v-if="view.footer" class="faint text-xs" data-test="meta-footer">{{ view.footer }}</p>
  </div>
</template>
