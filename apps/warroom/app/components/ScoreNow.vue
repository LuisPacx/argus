<script setup lang="ts">
// One muted line: the Narrative's latest Score when it differs from the Score the Proposal was created from (nothing when it does not).
import { scoreNowLine } from "../utils/score-now.ts";
const props = defineProps<{ created: { total: number; scores: Record<string, number> } | null; latest?: { total: number; scores: Record<string, number> } | null }>();
const line = computed(() => scoreNowLine(props.created, props.latest));
</script>

<template>
  <p v-if="line" class="faint min-w-0 break-words text-xs tabular-nums" data-test="score-now" title="The Narrative was judged again after this Proposal was created; the Score above is the one it was created from">{{ line }}</p>
</template>
