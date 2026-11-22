<script setup lang="ts">
// The Proposal(s) made from a Narrative, as links to /proposals/<id> (War Room ticket 19). No block when there are none. Text only.
import type { NarrativeProposalPayload } from "../utils/verdict.ts";

// Closed and dismissed ones are hidden by default (ticket 20): the page passes the shown rows, the hidden count and the toggle link.
defineProps<{ proposals: NarrativeProposalPayload[]; hiddenCount?: number; showing?: boolean; toggleTo?: string }>();
</script>

<template>
  <section v-if="proposals.length > 0 || (hiddenCount ?? 0) > 0" class="surface rise grid gap-4" style="--i: 1" data-test="narrative-proposals">
    <h3 class="section-title">Proposals from this Narrative</h3>
    <ShowClosedToggle v-if="toggleTo && (hiddenCount ?? 0) > 0" :count="hiddenCount ?? 0" :showing="!!showing" :to="toggleTo" />
    <ul class="grid gap-2.5">
      <li v-for="p in proposals" :key="p.id" class="inset flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5 px-4 py-3 text-sm">
        <NuxtLink :to="`/proposals/${p.id}`" class="link min-w-0 break-words font-semibold" data-test="narrative-proposal">{{ p.name }}<span v-if="p.ticker" class="muted font-normal"> ${{ p.ticker }}</span></NuxtLink>
        <span class="pill pill-outline">{{ p.kind === "meme" ? "meme idea" : "Tech" }}</span>
        <StatusPill :status="p.status" />
        <VerdictPill v-if="p.kind === 'meme'" label="Idea" :verdict="p.ideaVerdict" data-test="idea-pill" />
      </li>
    </ul>
  </section>
</template>
