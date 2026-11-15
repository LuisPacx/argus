<script setup lang="ts">
// The side panel of one pipeline node: what it does, its rules with the real values (the default beside a value only when they differ, the
// Rubric version on the buildability gate, used / cap on a per-day run cap), the lines that touch it with their gates and last-24 h counts,
// its Claude spend, the ADRs and tickets that explain it and the code files. Repo paths are shown as text, never as links; every string is
// drawn as text (no raw-HTML directive). Focus moves to the close button when it opens; the page returns it to the node on close.
import type { PipelineView } from "../utils/pipeline-layout.ts";
defineProps<{ node: PipelineView["nodes"][number] }>();
defineEmits<{ close: [] }>();
const closeButton = ref<HTMLButtonElement | null>(null);
onMounted(() => closeButton.value?.focus());
</script>

<template>
  <aside class="pipe-panel grid content-start gap-4" role="dialog" :aria-label="`${node.label}: details`" data-test="node-panel">
    <div class="flex items-start justify-between gap-3">
      <div class="grid gap-1.5">
        <h3 class="section-title" data-test="panel-title">{{ node.label }}</h3>
        <span class="pill w-fit" :class="node.tone" data-test="panel-status">{{ node.statusWord }}</span>
      </div>
      <button ref="closeButton" type="button" class="btn btn-ghost" aria-label="Close the details" data-test="panel-close" @click="$emit('close')">Close</button>
    </div>

    <p class="text-sm" data-test="panel-what">{{ node.what }}</p>
    <p v-if="node.note" class="note muted" data-test="panel-note">{{ node.note }}</p>

    <section v-if="node.chips.length > 0" class="grid gap-2" data-test="panel-sources">
      <h4 class="eyebrow">Sources</h4>
      <ul class="pipe-panel-list">
        <li v-for="c in node.chips" :key="c.id" class="flex items-center justify-between gap-2">
          <span class="font-semibold">{{ c.label }}</span>
          <span class="pill" :class="c.tone">{{ c.statusWord }}</span>
        </li>
      </ul>
    </section>

    <section v-if="node.rules.length > 0" class="grid gap-2" data-test="panel-rules">
      <h4 class="eyebrow">Rules</h4>
      <ul class="pipe-panel-list">
        <li v-for="(r, i) in node.rules" :key="i" class="grid gap-0.5" :data-test="`rule-${i}`">
          <span class="muted">{{ r.label }}</span>
          <span>
            <strong data-test="rule-value">{{ r.value }}</strong>
            <span v-if="r.rubric" class="pill pill-outline ml-2" data-test="rule-rubric">{{ r.rubric }}</span>
            <span v-if="r.defaultValue" class="muted ml-2" data-test="rule-default">(default {{ r.defaultValue }})</span>
          </span>
          <span v-if="r.used" class="note muted" data-test="rule-used">{{ r.used }}</span>
          <span v-if="r.error" class="note note-red" data-test="rule-error">{{ r.error }}</span>
        </li>
      </ul>
    </section>

    <section v-if="node.lines.length > 0" class="grid gap-2" data-test="panel-lines">
      <h4 class="eyebrow">Lines in and out</h4>
      <ul class="pipe-panel-list">
        <li v-for="l in node.lines" :key="l.id" class="grid gap-0.5" :data-test="`line-${l.id}`">
          <span>{{ l.text }}</span>
          <span v-if="l.count" class="note muted">{{ l.count }}</span>
          <span v-for="(g, k) in l.gates" :key="k" class="note muted" data-test="line-gate">Gate: {{ g }}</span>
        </li>
      </ul>
    </section>

    <section class="grid gap-2" data-test="panel-spend">
      <h4 class="eyebrow">Claude spend, last 24 h</h4>
      <p v-if="node.spend" class="text-sm" :title="node.spend.title" data-test="panel-spend-lines">{{ node.spend.lines.join(", ") }}</p>
      <p v-else-if="node.brainTask" class="note muted" data-test="panel-spend-none">Task {{ node.brainTask }}: no live numbers right now.</p>
      <p v-else class="note muted" data-test="panel-spend-none">Plain code: it spends no Claude.</p>
    </section>

    <section v-if="node.worker.length > 0 || node.brainTask" class="grid gap-1" data-test="panel-runs">
      <h4 class="eyebrow">Runs as</h4>
      <p class="note muted">
        <template v-if="node.worker.length > 0">Worker pass: {{ node.worker.join(", ") }}.</template>
        <template v-if="node.brainTask"> Claude task: {{ node.brainTask }}.</template>
      </p>
    </section>

    <section v-if="node.adrs.length > 0" class="grid gap-2" data-test="panel-adrs">
      <h4 class="eyebrow">ADRs</h4>
      <ul class="pipe-panel-list">
        <li v-for="a in node.adrs" :key="a"><code class="pipe-panel-path">{{ a }}</code></li>
      </ul>
    </section>
    <section v-if="node.tickets.length > 0" class="grid gap-2" data-test="panel-tickets">
      <h4 class="eyebrow">Tickets</h4>
      <ul class="pipe-panel-list">
        <li v-for="t in node.tickets" :key="t"><code class="pipe-panel-path">{{ t }}</code></li>
      </ul>
    </section>
    <section v-if="node.files.length > 0" class="grid gap-2" data-test="panel-files">
      <h4 class="eyebrow">Code</h4>
      <ul class="pipe-panel-list">
        <li v-for="f in node.files" :key="f"><code class="pipe-panel-path">{{ f }}</code></li>
      </ul>
    </section>
  </aside>
</template>
