<script setup lang="ts">
// Radar suggestions on /research (human researcher ticket 07): the live Trends as buttons. Pressing one only tells the page which subject to put in
// the topic box ("pick"); it starts nothing, the Operator presses Research himself. Text only: the subject is third-party and is shown through {{ }},
// cut to one line by suggestionsView. Template-only on purpose (for server/test/research-suggestions.test.ts, which renders it): view.
import type { SuggestionsView } from "../utils/research-suggestions.ts";

defineProps<{ view: SuggestionsView }>();
defineEmits<{ pick: [topic: string] }>();
</script>

<template>
  <div class="grid min-w-0 gap-2" data-test="suggestions">
    <p class="faint text-xs">Suggestions from the radar: press one to put it in the topic box. Nothing runs until you press Research.</p>
    <p v-if="view.empty" class="muted min-w-0 break-words text-sm" data-test="suggestions-empty">{{ view.empty }}</p>
    <ul v-else class="flex min-w-0 flex-wrap gap-2">
      <li v-for="s in view.rows" :key="s.key" class="min-w-0 max-w-full">
        <button type="button" class="btn block min-w-0 max-w-full whitespace-normal break-all text-left" :data-test="`suggestion-${s.key}`" @click="$emit('pick', s.pick)">
          <span class="break-words font-medium" data-test="suggestion-topic">{{ s.topic }}</span>
          <span class="faint ml-2 text-xs" data-test="suggestion-score">Score {{ s.score }}</span>
          <span v-if="s.sources" class="faint ml-2 break-words text-xs" data-test="suggestion-sources">{{ s.sources }}</span>
        </button>
      </li>
    </ul>
  </div>
</template>
