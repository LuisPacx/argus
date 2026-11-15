<script setup lang="ts">
// /pipeline, "How it works": the pipeline logic drawn from the one graph definition in packages/core/src/pipeline-graph.ts. The rule values on
// it are the code's own constants (the buildability gate is the stored Rubric's). The last-24 h counts on the edges and the Claude spend on
// the nodes come from /api/pipeline-live and refresh on a 10 s poll like /activity; when that route fails the static graph stays, with a note.
import { pipelineView } from "../utils/pipeline-layout.ts";

const { data: pipeline, error } = await useFetch("/api/pipeline");
const { data: liveData, error: liveError, refresh: refreshLive } = await useFetch("/api/pipeline-live");
// Nodes rise in when the page is reached by a client navigation; on the first (hydrating) load they are simply there.
const animate = !useNuxtApp().isHydrating;
// A failed fetch (first or later) drops the numbers rather than showing stale ones beside a notice.
const live = computed(() => (liveError.value ? null : (liveData.value ?? null)));
const view = computed(() => (pipeline.value ? pipelineView(pipeline.value, live.value) : null));

// The node whose panel is open. The panel reads the same view (so its numbers refresh with the poll); closing it returns focus to the node.
const selectedId = ref<string | null>(null);
const selectedNode = computed(() => view.value?.nodes.find((n) => n.id === selectedId.value) ?? null);
async function close() {
  const id = selectedId.value;
  selectedId.value = null;
  await nextTick();
  if (id !== null) document.getElementById(`pipe-node-${id}`)?.focus();
}
const onKey = (e: KeyboardEvent) => {
  if (e.key === "Escape" && selectedId.value !== null) void close();
};

let poll: ReturnType<typeof setInterval> | undefined;
onMounted(() => {
  poll = setInterval(() => void refreshLive(), 10_000);
  window.addEventListener("keydown", onKey);
});
onBeforeUnmount(() => {
  clearInterval(poll);
  window.removeEventListener("keydown", onKey);
});
</script>

<template>
  <div class="grid gap-6">
    <div>
      <h2 class="page-title">How it works</h2>
      <p class="page-sub">What argus does with a Signal, left to right. Drawn from the code's own settings, so it cannot drift from them.</p>
    </div>
    <p v-if="error" class="surface note note-red" data-test="pipeline-error">{{ error.statusMessage || error.message }}</p>
    <template v-else-if="view">
      <p v-if="liveError" class="note muted" data-test="pipeline-live-error">Live numbers unavailable.</p>
      <p v-else-if="live" class="note muted" data-test="pipeline-live-note">
        The numbers on the lines are the last 24 hours, refreshed every 10 seconds. The figures on a node are Claude spend: Est. usage on the subscription, and real
        API dollars on their own line when the API fallback ran. They are never added together.
      </p>
      <p v-if="pipeline?.envSource === 'warroom-process'" class="note muted" data-test="pipeline-env-note">
        Limit values come from the War Room process's ARGUS_* settings and may differ from the worker's.
      </p>
      <PipelineGraph :view="view" :animate="animate" :selected="selectedId" @open="selectedId = $event" />
      <Transition name="pipe-panel" mode="out-in">
        <PipelineNodePanel v-if="selectedNode" :key="selectedNode.id" :node="selectedNode" @close="close" />
      </Transition>
    </template>
    <p v-else class="surface muted text-sm">No pipeline graph yet.</p>
    <p class="faint text-xs">
      The graph lives in packages/core/src/pipeline-graph.ts; the diagrams in docs/architecture.md are generated from it (pnpm docs:graph).
      A test fails when the code gains a Source, a worker pass, a brain task or a cap the graph does not show.
    </p>
  </div>
</template>
