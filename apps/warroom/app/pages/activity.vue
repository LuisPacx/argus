<script setup lang="ts">
const { data: sources, refresh: refreshSources } = await useFetch("/api/activity/sources", { default: () => [] });
const { data: narratives, refresh: refreshNarratives } = await useFetch("/api/activity/narratives", { default: () => [] });
const { data: runs, refresh: refreshRuns } = await useFetch("/api/activity/brain-runs", { default: () => [] });
const { data: usage, error: usageError, refresh: refreshUsage } = await useFetch("/api/research");

// Rows animate in when the page is reached by a client navigation; on the first (hydrating) load they are simply there.
const animate = !useNuxtApp().isHydrating;

const refresh = () => void Promise.all([refreshSources(), refreshNarratives(), refreshRuns(), refreshUsage()]);

// The clock starts at a fixed value so the server and the first client render agree; it is set to the real time on mount.
const nowMs = ref(0);
let poll: ReturnType<typeof setInterval> | undefined;
let clock: ReturnType<typeof setInterval> | undefined;
onMounted(() => {
  nowMs.value = Date.now();
  poll = setInterval(refresh, 10_000);
  clock = setInterval(() => (nowMs.value = Date.now()), 1_000);
});
onBeforeUnmount(() => {
  clearInterval(poll);
  clearInterval(clock);
});

const clockTime = (iso: string) => new Date(iso).toISOString().slice(11, 19) + " UTC";
const span = (secs: number) => {
  if (secs < 60) return `${secs}s`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ${secs % 60}s`;
  return `${Math.floor(secs / 3600)}h ${Math.floor((secs % 3600) / 60)}m`;
};
const ago = (iso: string | null) => {
  if (!iso) return "never";
  if (!nowMs.value) return clockTime(iso);
  return `${span(Math.max(0, Math.round((nowMs.value - new Date(iso).getTime()) / 1000)))} ago`;
};
const duration = (r: { status: string; startedAt: string; durationSec: number | null }) => {
  if (r.durationSec !== null) return span(r.durationSec);
  if (r.status === "in-flight") return nowMs.value ? `running ${span(Math.max(0, Math.round((nowMs.value - new Date(r.startedAt).getTime()) / 1000)))}` : "running";
  return "unknown";
};
const usd = (v: number) => `$${v.toFixed(2)}`;
const usedPct = computed(() => (usage.value && usage.value.budgetUsd > 0 ? Math.min(100, (usage.value.usedUsd / usage.value.budgetUsd) * 100) : 0));
</script>

<template>
  <div class="grid gap-10">
    <h2 class="page-title">Activity</h2>

    <section class="grid gap-3">
      <h3 class="section-title">Sources</h3>
      <p v-if="!sources.length" class="surface muted text-sm">No Sources have polled yet. The worker polls them on each ingest tick.</p>
      <TransitionGroup tag="div" name="row" :appear="animate" class="relative grid gap-3">
        <article v-for="(s, i) in sources" :key="s.sourceId" class="row row-static" :style="{ '--i': i }">
          <div class="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
            <span class="font-semibold">{{ s.label }} <span class="faint ml-1 text-sm font-normal">{{ s.sourceId }}</span></span>
            <span class="pill pill-ink">{{ signalsLabel(s.signals24h) }} in 24 h</span>
          </div>
          <p class="muted mt-1 text-sm">last fetch {{ ago(s.lastPolledAt) }} · last ok {{ ago(s.lastOkAt) }}</p>
          <p v-if="s.lastError" class="note note-red mt-2 w-full" data-test="source-error">{{ s.lastError }} ({{ s.lastErrorAt ? clockTime(s.lastErrorAt) : "" }})</p>
        </article>
      </TransitionGroup>
    </section>

    <section class="grid gap-3">
      <h3 class="section-title">Narratives</h3>
      <p v-if="!narratives.length" class="surface muted text-sm">No Narratives yet. The worker clusters new Signals after each ingest tick.</p>
      <TransitionGroup tag="div" name="row" :appear="animate" class="relative grid gap-3">
        <article v-for="(n, i) in narratives" :key="n.id" class="row" :style="{ '--i': i }">
          <NuxtLink :to="`/narratives/${n.id}`" class="row-link link font-semibold">{{ n.title }}</NuxtLink>
          <p class="muted mt-1 flex flex-wrap items-center gap-x-2 gap-y-1.5 text-sm">
            <span>{{ signalsLabel(n.signalCount) }} · created {{ ago(n.createdAt) }} ·</span>
            <template v-if="n.score">
              <span>score {{ n.score.total.toFixed(1) }} (Rubric v{{ n.score.rubricVersion }}) ·</span>
              <span class="pill" :class="n.gate?.passed ? 'pill-green' : 'pill-red'" data-test="gate">
                gate {{ n.gate?.passed ? "passed" : "failed" }}: {{ n.gate?.dimension }} {{ n.gate?.value }} of {{ n.gate?.min }} needed
              </span>
            </template>
            <template v-else>not judged yet</template>
          </p>
        </article>
      </TransitionGroup>
    </section>

    <section class="grid gap-3">
      <h3 class="section-title">Brain runs</h3>
      <p v-if="!runs.length" class="surface muted text-sm">No judge or propose runs yet.</p>
      <TransitionGroup tag="div" name="row" :appear="animate" class="relative grid gap-3">
        <article v-for="(r, i) in runs" :key="r.id" class="row row-static" :style="{ '--i': i }">
          <div class="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span class="font-semibold">{{ r.task }} #{{ r.id }}</span>
            <span class="faint text-sm">{{ r.backend }}, {{ r.model }}</span>
            <span class="pill" :class="r.status === 'success' ? 'pill-green' : r.status === 'in-flight' ? 'pill-accent' : r.status === 'cancelled' ? '' : 'pill-red'">{{ r.status }}</span>
          </div>
          <p class="muted mt-1 text-sm">
            started {{ ago(r.startedAt) }} · {{ duration(r) }} · {{ r.costKind === "est" ? "est. " : "" }}{{ usd(r.estCostUsd) }}{{ r.costKind === "api" ? " (API)" : "" }}
          </p>
        </article>
      </TransitionGroup>
    </section>

    <section class="grid gap-3">
      <h3 class="section-title">Usage today</h3>
      <p v-if="usageError" class="note note-red w-full" data-test="usage-error">{{ usageError.statusMessage || usageError.message }}</p>
      <div v-else-if="usage" class="row row-static">
        <p class="font-semibold" data-test="usage-text">{{ usd(usage.usedUsd) }} of {{ usd(usage.budgetUsd) }} research budget{{ usage.exhausted ? " (exhausted)" : "" }}</p>
        <div class="track my-3 w-full" role="progressbar" :aria-valuenow="Math.round(usedPct)" aria-valuemin="0" aria-valuemax="100">
          <div class="fill" :class="{ 'fill-bad': usage.exhausted }" :style="{ width: `${usedPct}%` }" />
        </div>
        <p class="muted text-sm" data-test="proposal-cap">{{ usage.newProposals }} of {{ usage.newProposalsCap }} Proposals today</p>
      </div>
      <p v-else class="surface muted text-sm">No usage figures yet.</p>
    </section>
  </div>
</template>
