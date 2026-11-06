<script setup lang="ts">
// One bar per Rubric dimension of a Score, 0 to 10. Dimension order is the order the Score was stored in (the Rubric's).
const props = defineProps<{ scores: Record<string, number>; total?: number }>();
const MAX = 10;
const rows = computed(() => Object.entries(props.scores).map(([key, value]) => ({ key, value, pct: Math.max(0, Math.min(100, (value / MAX) * 100)) })));
</script>

<template>
  <div class="grid gap-1 text-xs" data-test="score-bars">
    <div v-for="r in rows" :key="r.key" class="flex items-center gap-2">
      <span class="w-24 shrink-0 capitalize">{{ r.key }}</span>
      <div class="h-2 grow rounded bg-neutral-200 dark:bg-neutral-700" role="meter" :aria-label="r.key" :aria-valuenow="r.value" aria-valuemin="0" :aria-valuemax="MAX">
        <div class="h-2 rounded bg-primary" :style="{ width: `${r.pct}%` }" />
      </div>
      <span class="w-8 shrink-0 text-right tabular-nums">{{ r.value }}</span>
    </div>
    <p v-if="total !== undefined" class="text-muted">Total {{ total.toFixed(1) }} / {{ MAX }}</p>
  </div>
</template>
