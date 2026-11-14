<script setup lang="ts">
// /pipeline, "How it works": the pipeline logic drawn from the one graph definition in packages/core/src/pipeline-graph.ts. The rule values on
// it are the code's own constants (the buildability gate is the stored Rubric's). Static for now: the numbers do not poll.
import { pipelineView } from "../utils/pipeline-layout.ts";

const { data: pipeline, error } = await useFetch("/api/pipeline");
// Nodes rise in when the page is reached by a client navigation; on the first (hydrating) load they are simply there.
const animate = !useNuxtApp().isHydrating;
const view = computed(() => (pipeline.value ? pipelineView(pipeline.value) : null));
</script>

<template>
  <div class="grid gap-6">
    <div>
      <h2 class="page-title">How it works</h2>
      <p class="page-sub">What argus does with a Signal, left to right. Drawn from the code's own settings, so it cannot drift from them.</p>
    </div>
    <p v-if="error" class="surface note note-red" data-test="pipeline-error">{{ error.statusMessage || error.message }}</p>
    <PipelineGraph v-else-if="view" :view="view" :animate="animate" />
    <p v-else class="surface muted text-sm">No pipeline graph yet.</p>
    <p class="faint text-xs">
      The graph lives in packages/core/src/pipeline-graph.ts; the diagrams in docs/architecture.md are generated from it (pnpm docs:graph).
      A test fails when the code gains a Source, a worker pass, a brain task or a cap the graph does not show.
    </p>
  </div>
</template>
