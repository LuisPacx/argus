<script setup lang="ts">
// The home page's Radar strip (trend radar ticket 01): one line that says how many Trends are shown and links to /radar, and the banner for any
// source that has been down for over an hour. Text only. Template-only on purpose (for server/test/radar-render.test.ts): view.
import type { RadarStripView } from "../utils/radar.ts";

defineProps<{ view: RadarStripView | null }>();
</script>

<template>
  <section v-if="view" class="grid min-w-0 gap-2" data-test="radar-strip">
    <p v-for="a in view.alerts" :key="a" class="note note-amber min-w-0 break-words text-sm" role="status" data-test="radar-alert">{{ a }}</p>
    <NuxtLink to="/radar" class="surface min-w-0 break-words px-4 py-3 text-sm font-medium" data-test="radar-strip-link">{{ view.text }}</NuxtLink>
  </section>
</template>
