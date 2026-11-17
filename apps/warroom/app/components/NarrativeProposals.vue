<script setup lang="ts">
// The Proposal(s) made from a Narrative, as links to /proposals/<id> (War Room ticket 19). No block when there are none. Text only.
import type { NarrativeProposalPayload } from "../utils/verdict.ts";

defineProps<{ proposals: NarrativeProposalPayload[] }>();
</script>

<template>
  <section v-if="proposals.length > 0" class="surface rise" style="--i: 1" data-test="narrative-proposals">
    <h3 class="section-title mb-4">Proposals from this Narrative</h3>
    <ul class="grid gap-2.5">
      <li v-for="p in proposals" :key="p.id" class="inset flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5 px-4 py-3 text-sm">
        <NuxtLink :to="`/proposals/${p.id}`" class="link min-w-0 break-words font-semibold" data-test="narrative-proposal">{{ p.name }}<span v-if="p.ticker" class="muted font-normal"> ${{ p.ticker }}</span></NuxtLink>
        <span class="pill pill-outline">{{ p.kind === "meme" ? "meme idea" : "Tech" }}</span>
        <StatusPill :status="p.status" />
      </li>
    </ul>
  </section>
</template>
