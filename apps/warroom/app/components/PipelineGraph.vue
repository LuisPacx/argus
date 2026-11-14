<script setup lang="ts">
// The "How it works" graph: the pipeline stages as Soft Cards in fixed columns, left to right, with the edges between them as SVG paths.
// Text only (no raw-HTML directive). Template-only on purpose: server/test/pipeline-render.test.ts renders it. The geometry and words
// come from utils/pipeline-layout.ts, the graph from GET /api/pipeline. Motion is Vue's own <TransitionGroup> (the .pipe-* classes).
import type { PipelineView } from "../utils/pipeline-layout.ts";
defineProps<{ view: PipelineView; animate?: boolean }>();
</script>

<template>
  <section class="grid gap-4" data-test="pipeline" aria-label="Pipeline graph">
    <div class="pipe-scroll" data-test="pipeline-scroll" tabindex="0" role="group" aria-label="Pipeline graph, scrolls sideways on a narrow screen">
      <div class="pipe-canvas" :style="{ width: `${view.width}px`, height: `${view.height}px` }">
        <svg class="pipe-edges" :width="view.width" :height="view.height" :viewBox="`0 0 ${view.width} ${view.height}`" aria-hidden="true">
          <defs>
            <marker id="pipe-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M 0 1 L 9 5 L 0 9 z" class="pipe-arrow" />
            </marker>
          </defs>
          <g v-for="e in view.edges" :key="e.id" :data-test="`edge-${e.id}`">
            <path :d="e.d" class="pipe-edge" :class="{ 'is-dashed': e.dashed }" marker-end="url(#pipe-arrow)" />
            <g v-if="e.gate" :transform="`translate(${e.gate.x} ${e.gate.y})`" :data-test="`gate-${e.id}`">
              <rect x="-6" y="-6" width="12" height="12" rx="2" transform="rotate(45)" class="pipe-gate" />
              <title>{{ e.gate.text }}</title>
            </g>
          </g>
        </svg>
        <TransitionGroup name="pipe" tag="div" :appear="animate">
          <article
            v-for="(n, i) in view.nodes"
            :key="n.id"
            class="pipe-node"
            :class="`is-${n.status}`"
            :style="{ ...n.style, '--i': i }"
            :data-test="`node-${n.id}`"
          >
            <div class="pipe-head">
              <h3 class="pipe-label">{{ n.label }}</h3>
              <span class="pill pipe-pill" :class="n.tone" :title="n.note ?? undefined" data-test="node-status">{{ n.statusWord }}</span>
            </div>
            <ul v-if="n.chips.length > 0" class="pipe-chips" :data-test="`chips-${n.id}`">
              <li v-for="c in n.chips" :key="c.id" class="pipe-chip" :data-test="`chip-${c.id}`">
                <span class="pipe-chip-name">{{ c.label }}</span>
                <span class="pill pipe-pill" :class="c.tone">{{ c.statusWord }}</span>
              </li>
            </ul>
          </article>
        </TransitionGroup>
      </div>
    </div>

    <ul v-if="view.nodes.some((n) => n.note)" class="grid gap-1" data-test="pipeline-notes">
      <li v-for="n in view.nodes.filter((x) => x.note)" :key="n.id" class="note muted"><strong>{{ n.label }} ({{ n.statusWord }}):</strong> {{ n.note }}</li>
    </ul>

    <div class="surface grid gap-3">
      <h3 class="section-title">How an item moves</h3>
      <p class="note muted">A diamond on an edge is a gate: an item passes only if it meets the rule. A dashed edge is an Operator decision or a path that is not wired yet.</p>
      <ol class="grid gap-1.5 text-sm" data-test="pipeline-legend">
        <li v-for="l in view.legend" :key="l.id" :data-test="`legend-${l.id}`">
          {{ l.text }}<span v-if="l.gate" class="pill pill-outline ml-2" data-test="legend-gate">{{ l.gate }}</span>
        </li>
      </ol>
    </div>
  </section>
</template>
