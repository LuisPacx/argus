<script setup lang="ts">
// /radar: the rising Google Trends terms the worker found in the last 24 hours, each with its untokenized check (trend radar ticket 01). The worker
// polls every 15 minutes; this page only displays what it stored (GET /api/radar, read only). Opening the page writes nothing.
import { radarPageView, RADAR_POLL_MS } from "../utils/radar.ts";

const { data, refresh } = await useFetch("/api/radar", { default: () => null });
// 0 until mounted, so the server and the first client render agree (absolute UTC text); see composables/useNowMs.ts.
const nowMs = useNowMs();
let poll: ReturnType<typeof setInterval> | undefined;
onMounted(() => {
  poll = setInterval(refresh, RADAR_POLL_MS);
});
onBeforeUnmount(() => clearInterval(poll));
const view = computed(() => radarPageView(data.value, nowMs.value));
</script>

<template>
  <div class="grid gap-6">
    <h2 class="page-title">Radar</h2>
    <p class="note muted">
      Subjects that several independent places carry right now (Google Trends in several countries and a list of news feeds), scored by how many agree, with whether a live token already carries the name. Read by the worker every 15 minutes; a token counts only when it passes the
      live-token test (priced, real liquidity, a market cap in proportion to it), and a drained pool or a fake cap is shown as a lookalike and not counted. Nothing here is advice or a launch signal.
    </p>
    <RadarPanel :view="view" />
  </div>
</template>
