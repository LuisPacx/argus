<script setup lang="ts">
// The Picks list on /research (human researcher ticket 03): one row per Pick, newest first, with the coin's snapshot at the moment it was picked,
// the Operator's topic and reason, and whether it had bonded. Text only: the name, address, reason and topic are untrusted and are shown through
// {{ }}, cut to a line by picksView. The only link is the coin's DexScreener page. Template-only on purpose (for server/test/research-render.test.ts,
// which renders it): view.
import type { PicksView } from "../utils/research.ts";

defineProps<{ view: PicksView }>();
</script>

<template>
  <div class="grid min-w-0 gap-3" data-test="picks">
    <div v-if="view.rate" class="surface grid min-w-0 gap-1 text-sm" data-test="pick-rate">
      <p class="font-semibold">Bonding rate (Picks that bonded within 24 hours of the Pick)</p>
      <p data-test="pick-rate-all">{{ view.rate.all }}</p>
      <p data-test="pick-rate-week">{{ view.rate.week }}</p>
      <p class="faint text-xs" data-test="pick-rate-left-out">{{ view.rate.leftOut }}</p>
    </div>
    <p v-if="view.empty" class="surface muted min-w-0 break-words text-sm" data-test="picks-empty">{{ view.empty }}</p>
    <p v-else class="faint min-w-0 break-words text-xs" data-test="picks-summary">{{ view.summary }}</p>
    <ul class="grid min-w-0 gap-3">
      <li v-for="r in view.rows" :id="`pick-${r.id}`" :key="r.id" class="row row-static grid min-w-0 gap-1.5" :data-test="`pick-${r.id}`">
        <div class="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
          <span class="min-w-0 break-words font-semibold" data-test="pick-title">{{ r.title }}</span>
          <span class="pill" :class="r.bonded ? 'pill-green' : 'pill-outline'" data-test="pick-bonded">{{ r.bondedLabel }}</span>
          <span v-if="r.topic" class="pill pill-outline min-w-0 break-words" data-test="pick-topic">{{ r.topic }}</span>
          <span class="faint text-xs" data-test="pick-picked">{{ r.picked }}</span>
        </div>
        <p class="muted min-w-0 break-words text-xs" data-test="pick-facts">{{ r.facts.join(", ") }}</p>
        <p class="min-w-0 break-words text-sm" data-test="pick-outcome"><span class="font-medium">Outcome: {{ r.outcome.label }}</span> <span class="muted">({{ r.outcome.detail }})</span></p>
        <p v-if="r.outcome.marks.length > 0" class="muted min-w-0 break-words text-xs" data-test="pick-marks">{{ r.outcome.marks.join(", ") }}</p>
        <p v-if="r.reason"class="min-w-0 break-words text-sm" data-test="pick-reason">{{ r.reason }}</p>
        <p class="faint min-w-0 break-all text-xs" data-test="pick-ca">
          <a v-if="r.href" :href="r.href" class="underline" target="_blank" rel="noopener noreferrer">{{ r.ca }}</a>
          <template v-else>{{ r.ca }}</template>
        </p>
      </li>
    </ul>
  </div>
</template>
