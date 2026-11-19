<script setup lang="ts">
// /moments: the clips that are rising fast in the Watched topic (moment scanner ticket 01). The worker scans X every 30 minutes and stores each
// post with its counts at each reading; this page only displays what it stored (GET /api/moments, read only) and offers Resume while the
// X session is stopped. Opening the page writes nothing.
import { momentsPageView, MOMENTS_POLL_MS } from "../utils/moments.ts";

const { data, refresh } = await useFetch("/api/moments", { default: () => null });
// 0 until mounted, so the server and the first client render agree (absolute UTC text); see composables/useNowMs.ts.
const nowMs = useNowMs();
let poll: ReturnType<typeof setInterval> | undefined;
onMounted(() => {
  poll = setInterval(refresh, MOMENTS_POLL_MS);
});
onBeforeUnmount(() => clearInterval(poll));
const view = computed(() => momentsPageView(data.value, nowMs.value));
</script>

<template>
  <div class="grid gap-6">
    <h2 class="page-title">Moments</h2>
    <p class="note muted">
      Video clips that are rising fast in the watched topic: views an hour since posting, and the rate since the last reading. Read from X by the worker every 30 minutes; newest reading first.
      Nothing here is advice or a launch signal.
    </p>
    <MomentsPanel :view="view" @resumed="refresh" />
  </div>
</template>
