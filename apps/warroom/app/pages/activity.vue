<script setup lang="ts">
const { data: sources, refresh: refreshSources } = await useFetch("/api/activity/sources", { default: () => [] });
const { data: narratives, refresh: refreshNarratives } = await useFetch("/api/activity/narratives", { default: () => [] });
const { data: runs, refresh: refreshRuns } = await useFetch("/api/activity/brain-runs", { default: () => [] });
const { data: usage, error: usageError, refresh: refreshUsage } = await useFetch("/api/research");

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
  <div class="space-y-8">
    <h2 class="text-xl font-semibold">Activity</h2>

    <section class="space-y-2">
      <h3 class="text-lg font-semibold">Sources</h3>
      <p v-if="!sources.length" class="text-sm text-muted">No Sources have polled yet. The worker polls them on each ingest tick.</p>
      <UCard v-for="s in sources" :key="s.sourceId">
        <div class="flex flex-wrap items-baseline justify-between gap-2">
          <span class="font-semibold">{{ s.label }} <span class="text-sm font-normal text-muted">{{ s.sourceId }}</span></span>
          <span class="text-sm text-muted">{{ s.signals24h }} {{ s.signals24h === 1 ? "Signal" : "Signals" }} in 24 h</span>
        </div>
        <p class="text-sm text-muted">last fetch {{ ago(s.lastPolledAt) }} · last ok {{ ago(s.lastOkAt) }}</p>
        <p v-if="s.lastError" class="mt-1 w-full text-sm text-red-600" data-test="source-error">{{ s.lastError }} ({{ s.lastErrorAt ? clockTime(s.lastErrorAt) : "" }})</p>
      </UCard>
    </section>

    <section class="space-y-2">
      <h3 class="text-lg font-semibold">Narratives</h3>
      <p v-if="!narratives.length" class="text-sm text-muted">No Narratives yet. The worker clusters new Signals after each ingest tick.</p>
      <UCard v-for="n in narratives" :key="n.id">
        <NuxtLink :to="`/narratives/${n.id}`" class="font-semibold">{{ n.title }}</NuxtLink>
        <p class="text-sm text-muted">
          {{ n.signalCount }} {{ n.signalCount === 1 ? "Signal" : "Signals" }} · created {{ ago(n.createdAt) }} ·
          <template v-if="n.score">
            score {{ n.score.total.toFixed(1) }} (Rubric v{{ n.score.rubricVersion }}) ·
            <span :class="n.gate?.passed ? 'text-green-600' : 'text-red-600'" data-test="gate">
              gate {{ n.gate?.passed ? "passed" : "failed" }}: {{ n.gate?.dimension }} {{ n.gate?.value }} of {{ n.gate?.min }} needed
            </span>
          </template>
          <template v-else>not judged yet</template>
        </p>
      </UCard>
    </section>

    <section class="space-y-2">
      <h3 class="text-lg font-semibold">Brain runs</h3>
      <p v-if="!runs.length" class="text-sm text-muted">No judge or propose runs yet.</p>
      <UCard v-for="r in runs" :key="r.id">
        <div class="flex flex-wrap items-baseline justify-between gap-2">
          <span class="font-semibold">{{ r.task }} <span class="text-sm font-normal text-muted">#{{ r.id }} · {{ r.backend }} · {{ r.model }}</span></span>
          <span class="text-sm" :class="r.status === 'success' || r.status === 'in-flight' ? 'text-muted' : 'text-red-600'">{{ r.status }}</span>
        </div>
        <p class="text-sm text-muted">
          started {{ ago(r.startedAt) }} · {{ duration(r) }} · {{ r.costKind === "est" ? "est. " : "" }}{{ usd(r.estCostUsd) }}{{ r.costKind === "api" ? " (API)" : "" }}
        </p>
      </UCard>
    </section>

    <section class="space-y-2">
      <h3 class="text-lg font-semibold">Usage today</h3>
      <p v-if="usageError" class="w-full text-sm text-red-600" data-test="usage-error">{{ usageError.statusMessage || usageError.message }}</p>
      <UCard v-else-if="usage">
        <p class="text-sm" data-test="usage-text">{{ usd(usage.usedUsd) }} of {{ usd(usage.budgetUsd) }} research budget{{ usage.exhausted ? " (exhausted)" : "" }}</p>
        <div class="my-2 h-2 w-full rounded bg-gray-200" role="progressbar" :aria-valuenow="Math.round(usedPct)" aria-valuemin="0" aria-valuemax="100">
          <div class="h-2 rounded" :class="usage.exhausted ? 'bg-red-600' : 'bg-green-600'" :style="{ width: `${usedPct}%` }" />
        </div>
        <p class="text-sm" data-test="proposal-cap">{{ usage.newProposals }} of {{ usage.newProposalsCap }} Proposals today</p>
      </UCard>
      <p v-else class="text-sm text-muted">No usage figures yet.</p>
    </section>
  </div>
</template>
