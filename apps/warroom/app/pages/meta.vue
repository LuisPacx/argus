<script setup lang="ts">
// /meta: the New Meta alert, then the Current Meta (Metas, then Watching; GET /api/current-meta), then the collapsed "All launch themes": every
// launch theme of the latest run, counts only (GET /api/metas). This page only displays what the worker stored (see utils/meta.ts). The 6 h / 24 h
// toggle is a link, so the choice lives in the URL; `/meta#all-launch-themes` opens the closed list.
import { currentMetaView, META_POLL_MS, metaView } from "../utils/meta.ts";
import { NEW_META_POLL_MS, newMetaView } from "../utils/new-meta.ts";

const route = useRoute();
const window = computed<"6h" | "24h">(() => (route.query.window === "6h" ? "6h" : "24h"));
const { data: metas, refresh: refreshMetas } = await useFetch("/api/metas", { query: { window, limit: 50 }, default: () => null });
const { data: current, refresh: refreshCurrent } = await useFetch("/api/current-meta", { default: () => null });
// The Operator's angle requests (ticket 11): the status line under each Meta's "Add an angle" form. Its key lets the form refresh it after a send.
const { data: angles, refresh: refreshAngles } = await useFetch("/api/meme-angle", { key: "meme-angle", default: () => null });

const { data: newMetas, refresh: refreshNewMeta } = await useFetch("/api/new-metas", { default: () => null });

// 0 until mounted, so the server and the first client render agree (absolute UTC text); see composables/useNowMs.ts.
const nowMs = useNowMs();
let metaTimer: ReturnType<typeof setInterval> | undefined;
let newMetaTimer: ReturnType<typeof setInterval> | undefined;
const themes = ref<HTMLDetailsElement | null>(null);
// The fragment names the closed list (or a theme row inside it): open it so the target is visible.
const openForHash = () => {
  let target: HTMLElement | null = null;
  try {
    target = route.hash.length > 1 ? document.getElementById(decodeURIComponent(route.hash.slice(1))) : null;
  } catch {
    // a malformed fragment names nothing
  }
  if (themes.value && (route.hash === "#all-launch-themes" || (target !== null && themes.value.contains(target)))) {
    themes.value.open = true;
    target?.scrollIntoView();
  }
};
onMounted(() => {
  metaTimer = setInterval(() => void Promise.all([refreshMetas(), refreshCurrent(), refreshAngles()]), META_POLL_MS);
  newMetaTimer = setInterval(() => void refreshNewMeta(), NEW_META_POLL_MS);
  openForHash();
});
watch(() => route.hash, () => nextTick(openForHash));
onBeforeUnmount(() => {
  clearInterval(metaTimer);
  clearInterval(newMetaTimer);
});

const view = computed(() => metaView(metas.value, nowMs.value, { rows: 50, window: window.value }));
const currentSection = computed(() => currentMetaView(current.value, nowMs.value, angles.value));
const newMetaSection = computed(() => newMetaView(newMetas.value, nowMs.value));
const windows = computed(() => [
  { label: "Last 24 h", to: { path: "/meta", query: {}, hash: "#all-launch-themes" }, active: window.value === "24h" },
  { label: "Last 6 h", to: { path: "/meta", query: { window: "6h" }, hash: "#all-launch-themes" }, active: window.value === "6h" },
]);
</script>

<template>
  <div class="grid gap-6">
    <h2 class="page-title">Meta</h2>
    <p class="note muted">
      A Meta is a current trend with a token really high: its leading token has a market cap in the millions. Watching is not a Meta: a token is up, but has not
      reached that market cap yet. The list at the bottom is launch counts, not Metas.
    </p>
    <NewMeta :view="newMetaSection" />
    <CurrentMeta :view="currentSection" />
    <details id="all-launch-themes" ref="themes" class="grid gap-4" data-test="all-launch-themes">
      <summary class="surface flex min-h-11 cursor-pointer items-center font-semibold" data-test="all-launch-themes-summary">All launch themes ({{ view.rows.length }})</summary>
      <div class="mt-4 grid gap-4">
        <div class="grid min-w-0 gap-3">
          <SegmentedLinks label="Ranking window" :options="windows" class="w-fit" />
          <p class="muted min-w-0 text-sm">
            What the token market is launching, ranked over the {{ window === "6h" ? "last 6 hours" : "last 24 hours" }}: counts only. Migrations are unfiltered (no bot filter);
            "after 60 s" counts only those that came more than a minute after the launch.
          </p>
        </div>
        <MetaList :view="view" />
        <p v-if="view.footer" class="faint text-xs" data-test="meta-footer">{{ view.footer }}</p>
      </div>
    </details>
  </div>
</template>
