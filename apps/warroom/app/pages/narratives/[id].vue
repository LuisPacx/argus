<script setup lang="ts">
const route = useRoute();
const { data: n } = await useFetch(`/api/narratives/${route.params.id}`);
const pct = (value: number) => Math.max(0, Math.min(100, (value / 10) * 100));
</script>

<template>
  <div v-if="n" class="grid gap-6">
    <NuxtLink to="/narratives" class="link inline-flex items-center gap-2 justify-self-start text-sm font-medium">
      <svg class="size-4" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M13 8H3M7 4 3 8l4 4" /></svg>
      Back to Narratives
    </NuxtLink>
    <div>
      <h2 class="page-title">{{ n.title }}</h2>
      <p v-if="n.summary" class="mt-3 max-w-3xl leading-relaxed">{{ n.summary }}</p>
      <p class="muted mt-2 text-sm">
        {{ signalsLabel(n.signalCount) }} · started {{ fmtWhen(n.createdAt) }} · last Signal {{ fmtWhen(n.lastSignalAt) }} · last material change
        {{ fmtWhen(n.changedMateriallyAt) }}
      </p>
    </div>

    <div class="grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_380px]">
      <section class="surface rise" style="--i: 0">
        <h3 class="section-title mb-4">Score history</h3>
        <p v-if="n.scores.length === 0" class="note muted">Not scored yet. The judge scores new and materially changed Narratives every 30 minutes.</p>
        <ol v-else class="grid gap-3" data-testid="score-history">
          <li v-for="(s, si) in n.scores" :key="s.id" class="inset grid gap-4 p-5">
            <div class="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-sm">
              <span class="pill pill-accent px-3 py-1.5 text-base tabular-nums">{{ s.total.toFixed(1) }}<span class="text-xs font-medium opacity-70">/10</span></span>
              <span class="pill pill-outline">Rubric v{{ s.rubricVersion }}</span>
              <span class="faint ml-auto text-xs"><time :datetime="s.createdAt">{{ fmtWhen(s.createdAt) }}</time> · {{ signalsLabel(s.signalCount) }}</span>
            </div>
            <div class="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3 xl:grid-cols-5">
              <div v-for="(value, key) in s.scores" :key="key" class="grid gap-1.5 text-xs">
                <div class="flex justify-between gap-2"><span class="capitalize">{{ key }}</span><span class="font-semibold tabular-nums">{{ value }}</span></div>
                <div class="track" role="meter" :aria-label="String(key)" :aria-valuenow="value" aria-valuemin="0" aria-valuemax="10">
                  <div class="fill" :style="{ width: `${pct(value)}%`, '--i': si }" />
                </div>
              </div>
            </div>
            <p class="muted text-sm leading-relaxed">{{ s.rationale }}</p>
          </li>
        </ol>
      </section>

      <section v-if="n.runs.length > 0" class="surface rise" style="--i: 1">
        <h3 class="section-title mb-4">Judge runs</h3>
        <ul class="grid gap-2.5" data-testid="judge-runs">
          <li v-for="r in n.runs" :key="r.id" class="inset grid gap-2 px-4 py-3 text-sm">
            <div class="flex items-baseline justify-between gap-3">
              <time class="muted" :datetime="r.createdAt">{{ fmtWhen(r.createdAt) }}</time>
              <span class="font-semibold tabular-nums">{{ r.backend === "api" ? `$${r.totalCostUsd.toFixed(4)} real` : `$${r.totalCostUsd.toFixed(2)} est.` }}</span>
            </div>
            <div class="flex flex-wrap items-center gap-1.5">
              <span class="pill pill-outline" :data-backend="r.backend">{{ r.backend }}</span>
              <span class="pill pill-outline">{{ r.model }}</span>
              <span class="pill" :class="r.exitStatus === 'success' ? 'pill-accent' : 'pill-red'">{{ r.exitStatus }}</span>
            </div>
          </li>
        </ul>
      </section>
    </div>

    <section class="surface rise" style="--i: 2">
      <h3 class="section-title mb-4">Signals</h3>
      <ul class="grid gap-2.5">
        <li v-for="s in n.signals" :key="s.id" class="inset flex min-w-0 items-center gap-3 px-4 py-3 text-sm">
          <span class="pill pill-outline shrink-0">{{ s.sourceLabel }}</span>
          <a v-if="s.url" class="url-link grow" :href="s.url" :title="s.url" target="_blank" rel="noopener noreferrer">
            <span>{{ s.title }}</span>
            <svg class="size-3.5 shrink-0 opacity-70" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 2.5h4.5V7M13.5 2.5 7.5 8.5M12 9.5v3a1 1 0 0 1-1 1H3.5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h3" /></svg>
          </a>
          <span v-else class="min-w-0 grow truncate" :title="s.title">{{ s.title }}</span>
          <time class="faint shrink-0 text-xs" :datetime="s.publishedAt">{{ fmtWhen(s.publishedAt) }}</time>
        </li>
      </ul>
    </section>
  </div>
  <p v-else class="surface muted">Narrative not found.</p>
</template>
