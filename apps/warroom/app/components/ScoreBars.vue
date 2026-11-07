<script setup lang="ts">
// One thin horizontal bar per Rubric dimension of a Score, 0 to 10. Dimension order is the order the Score was stored in (the Rubric's).
// `compact` (list rows) shortens the labels to three letters; the full name stays in the tooltip. The bars grow in on mount (CSS, see .fill).
const props = defineProps<{ scores: Record<string, number>; compact?: boolean }>();
const MAX = 10;
const rows = computed(() => Object.entries(props.scores).map(([key, value]) => ({ key, value, pct: Math.max(0, Math.min(100, (value / MAX) * 100)) })));
</script>

<template>
  <div class="grid text-xs" :class="compact ? 'gap-1' : 'gap-3 text-sm'" data-test="score-bars">
    <div v-for="(r, i) in rows" :key="r.key" class="flex items-center gap-2.5" :title="`${r.key} ${r.value} / ${MAX}`">
      <span class="shrink-0 capitalize" :class="compact ? 'faint w-8' : 'w-28 sm:w-32'">{{ compact ? abbrev(r.key) : r.key }}</span>
      <div class="track grow" role="meter" :aria-label="r.key" :aria-valuenow="r.value" aria-valuemin="0" :aria-valuemax="MAX">
        <div class="fill" :style="{ width: `${r.pct}%`, '--i': i }" />
      </div>
      <span class="shrink-0 text-right font-semibold tabular-nums" :class="compact ? 'w-4' : 'w-5'">{{ r.value }}</span>
    </div>
  </div>
</template>
