<script setup lang="ts">
// The small pill on a /narratives row: the Operator's current verdict (War Room ticket 19). Nothing when there is none. With `label="Idea"` it is
// the Idea verdict pill on a meme Proposal (ticket 21: the list cards, the Narrative page's links and /proposals/<id>).
// Template-only name (for server/test/narrative-verdict-render.test.ts, which renders the template): pill.
import { verdictPill } from "../utils/verdict.ts";

const props = defineProps<{ verdict: string | null | undefined; label?: string }>();
const pill = computed(() => verdictPill(props.verdict, props.label));
</script>

<template>
  <span v-if="pill" class="pill" :class="pill.tone === 'good' ? 'pill-green' : 'pill-red'" :data-tone="pill.tone" data-test="verdict-pill">{{ pill.label }}</span>
</template>
