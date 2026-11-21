<script setup lang="ts">
// The Scoreboard on /research (human researcher ticket 08): the Operator's and the machine's bonded-within-24h rate over the last 7 days, each with n,
// the topics compared, the rows left out, and the verdict, which stays "not enough Picks yet" until each side has 20 finished Picks. It fetches its own data
// (GET /api/scoreboard, read only, no model) so the page only places it. Text only: the topics are Operator-typed and shown through {{ }}.
// Everything below the fetch is template-only on purpose (for server/test/research-scoreboard-render.test.ts, which renders it): view.
import { scoreboardView, type ScoreboardPayload } from "../utils/research-scoreboard.ts";

const { data, refresh } = await useFetch<ScoreboardPayload | null>("/api/scoreboard", { key: "scoreboard", default: () => null });
const view = computed(() => scoreboardView(data.value));
let timer: ReturnType<typeof setInterval> | undefined;
onMounted(() => {
  timer = setInterval(() => void refresh(), 60_000);
});
onBeforeUnmount(() => clearInterval(timer));
</script>

<template>
  <section class="surface grid min-w-0 gap-3" data-test="scoreboard">
    <h3 class="section-title" data-test="scoreboard-title">{{ view.title }}</h3>
    <p class="muted min-w-0 break-words text-xs" data-test="scoreboard-window">{{ view.window }} {{ view.rule }}</p>
    <p class="muted min-w-0 break-words text-xs" data-test="scoreboard-counted">{{ view.counted }}</p>
    <div class="grid min-w-0 gap-3 sm:grid-cols-2">
      <div v-for="s in view.compared" :key="s.label" class="grid min-w-0 gap-0.5" :data-test="`scoreboard-side-${s.label.toLowerCase()}`">
        <p class="text-xs font-semibold">{{ s.label }}</p>
        <p class="min-w-0 break-words text-lg font-semibold" data-test="scoreboard-rate">{{ s.rate }}</p>
        <p class="muted text-xs" data-test="scoreboard-n">{{ s.n }}</p>
        <p v-if="s.leftOut" class="faint min-w-0 break-words text-xs" data-test="scoreboard-left-out">{{ s.leftOut }}</p>
      </div>
    </div>
    <p class="min-w-0 break-words text-sm" :class="view.verdict.decided ? 'font-semibold' : 'muted'" :data-kind="view.verdict.kind" data-test="scoreboard-verdict">{{ view.verdict.text }}</p>
    <p class="muted min-w-0 break-words text-xs" data-test="scoreboard-topics">{{ view.topics }}</p>
    <div class="grid min-w-0 gap-1" data-test="scoreboard-outside">
      <p class="text-xs font-semibold">Shown on their own, never in the comparison</p>
      <p v-for="s in view.outside" :key="s.label" class="faint min-w-0 break-words text-xs" data-test="scoreboard-outside-row">{{ s.label }}: {{ s.rate }}, {{ s.n }}. {{ s.leftOut }}</p>
    </div>
  </section>
</template>
