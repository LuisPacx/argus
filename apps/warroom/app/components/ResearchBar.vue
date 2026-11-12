<script setup lang="ts">
// The home page's research usage as one compact full-width bar (see utils/research-bar.ts). Text only (no raw-HTML directive), no links.
// Template-only on purpose: server/test/research-bar.test.ts renders it.
import type { ResearchBarView } from "../utils/research-bar.ts";
defineProps<{ view: ResearchBarView }>();
</script>

<template>
  <section class="surface grid min-w-0 gap-2 px-4 py-3 text-sm" data-test="research-usage" aria-label="Research usage, last 24 hours">
    <div class="flex flex-wrap items-center gap-x-6 gap-y-2">
      <span class="section-title" title="Judge and propose runs over the rolling last 24 hours">{{ view.label }}</span>
      <span class="flex min-w-[11rem] flex-1 items-center gap-3" title="Budget in Est. usage (API-equivalent estimate reported by claude -p; runs use the Claude subscription, this is not a charge)">
        <span class="font-semibold tabular-nums">{{ view.budget }}</span>
        <span class="track min-w-12 flex-1" role="progressbar" aria-label="Budget" :aria-valuenow="Math.round(view.budgetPct)" aria-valuemin="0" aria-valuemax="100">
          <span class="fill block" :class="{ 'fill-bad': view.budgetExhausted }" :style="{ width: `${view.budgetPct}%`, '--i': 0 }" />
        </span>
      </span>
      <span class="flex min-w-[11rem] flex-1 items-center gap-3" title="New Proposals in the rolling last 24 hours, against the daily cap">
        <span class="muted">Proposals</span>
        <span class="font-semibold tabular-nums" data-test="proposal-cap">{{ view.proposals }}</span>
        <span class="track min-w-12 flex-1" role="progressbar" aria-label="Proposals" :aria-valuenow="Math.round(view.proposalsPct)" aria-valuemin="0" aria-valuemax="100">
          <span class="fill block" :style="{ width: `${view.proposalsPct}%`, '--i': 1 }" />
        </span>
      </span>
      <span class="muted text-xs tabular-nums" data-test="api-spend" title="Real money billed by the Anthropic API, unlike the Est. usage budget. Only the API fallback spends it.">{{ view.api }}</span>
    </div>
    <span v-for="a in view.alerts" :key="a" class="note note-amber block">{{ a }}</span>
    <details class="faint text-xs">
      <summary class="cursor-pointer select-none">details</summary>
      <ul class="mt-1 grid gap-1">
        <li v-for="d in view.details" :key="d">{{ d }}</li>
      </ul>
    </details>
  </section>
</template>
