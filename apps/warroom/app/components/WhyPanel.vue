<script setup lang="ts">
// "Why this Proposal": reason, interaction, top Signals, per-dimension scores with the judge rationale, and evidence, in one place.
// Everything in `view` is untrusted model or source text: interpolated as text only (no raw-HTML directive), and links only where
// `whyView` produced an http(s) href. Template-only on purpose: server/test/why-panel.test.ts renders it.
import type { WhyView } from "../utils/why.ts";
defineProps<{ view: WhyView }>();
</script>

<template>
  <section class="surface rise" style="--i: 1" data-test="why-panel">
    <h3 class="section-title">Why this Proposal</h3>
    <div class="mt-4 grid gap-5">
      <div data-test="why-reason">
        <p class="eyebrow mb-1.5">Reason</p>
        <p v-if="view.reason" class="leading-relaxed">{{ view.reason }}</p>
        <p v-else class="faint text-sm" data-test="absent">Not recorded for this Proposal.</p>
      </div>
      <div data-test="why-interaction">
        <p class="eyebrow mb-1.5">Interaction</p>
        <p v-if="view.interaction" class="leading-relaxed">{{ view.interaction }}</p>
        <p v-else class="faint text-sm" data-test="absent">Not recorded for this Proposal.</p>
      </div>
      <div data-test="why-signals">
        <p class="eyebrow mb-1.5">Top Signals</p>
        <ul v-if="view.signals.length > 0" class="grid gap-2">
          <li v-for="(s, i) in view.signals" :key="i" class="inset flex min-w-0 items-center gap-3 px-4 py-3 text-sm">
            <span class="pill pill-outline shrink-0">{{ s.source }}</span>
            <a v-if="s.href" class="url-link grow" :href="s.href" :title="s.href" target="_blank" rel="noopener noreferrer"><span>{{ s.title }}</span></a>
            <span v-else class="min-w-0 grow truncate" :title="s.title">{{ s.title }}</span>
            <span class="faint shrink-0 text-xs">{{ s.when }}</span>
          </li>
        </ul>
        <p v-else class="faint text-sm" data-test="absent">No Signals (hand-entered Proposal).</p>
      </div>
      <div data-test="why-score">
        <p class="eyebrow mb-1.5">Judge<span v-if="view.score" class="faint font-normal normal-case"> (Rubric version {{ view.score.rubricVersion }})</span></p>
        <template v-if="view.score">
          <ScoreBars :scores="view.score.scores" />
          <p v-if="view.score.rationale" class="muted mt-4 text-sm leading-relaxed" data-test="rationale">{{ view.score.rationale }}</p>
          <p v-else class="faint mt-4 text-sm" data-test="absent">No rationale recorded.</p>
        </template>
        <p v-else class="faint text-sm" data-test="absent">Not scored.</p>
      </div>
      <div data-test="why-evidence">
        <p class="eyebrow mb-1.5">Evidence</p>
        <ul v-if="view.evidence.length > 0" class="grid gap-2">
          <li v-for="(e, i) in view.evidence" :key="i" class="inset flex min-w-0 items-center px-4 py-3 text-sm">
            <a v-if="e.href" class="url-link" :href="e.href" :title="e.href" target="_blank" rel="noopener noreferrer"><span>{{ e.text }}</span></a>
            <span v-else class="min-w-0 truncate">{{ e.text }}</span>
          </li>
        </ul>
        <p v-else class="faint text-sm" data-test="absent">No evidence links.</p>
      </div>
    </div>
  </section>
</template>
