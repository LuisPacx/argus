<script setup lang="ts">
const { data, refresh } = await useFetch("/api/study");

let poll: ReturnType<typeof setInterval> | undefined;
onMounted(() => {
  poll = setInterval(refresh, 15_000);
});
onBeforeUnmount(() => {
  clearInterval(poll);
});

const pct = (v: number | null) => (v === null ? "n/a" : `${(v * 100).toFixed(v > 0 && v < 0.1 ? 1 : 0)}%`);
const dur = (secs: number) => {
  if (secs < 60) return `${secs}s`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m`;
  return `${Math.floor(secs / 3600)}h ${Math.floor((secs % 3600) / 60)}m`;
};
const minutes = (secs: number) => (secs % 60 === 0 && secs >= 60 ? `${secs / 60} min` : `${secs} s`);

type Stats = NonNullable<typeof data.value>["allTime"];
// The headline figures the page exists for come first; the rest explain where the other tokens went.
const headline = (s: Stats) => [
  { key: "seen", label: "Seen", value: String(s.seen), note: "pump.fun creates the worker received" },
  { key: "population", label: "In population", value: String(s.inPopulation), note: "metadata names a website or an X link" },
  { key: "captured", label: "Captured", value: String(s.captured), note: "frozen Snapshots written" },
  { key: "missed", label: "Missed", value: String(s.missed), note: `migrations whose create was never seen (${pct(s.missedShare)} of ${s.migrations})` },
  { key: "shell", label: "Empty app shells", value: pct(s.emptyShellShare), note: `${s.emptyShell} of ${s.websiteFetched} website Snapshots with a page` },
];
const rest = (s: Stats) => [
  { label: "Waiting for their age", value: s.pending },
  { label: "No website or X link (counted only)", value: s.counted },
  { label: "Late (worker not there at the fixed age)", value: s.late },
  { label: "Not captured, daily cap reached", value: s.capped },
  { label: "Metadata unreadable", value: s.unreadable },
  { label: "Other launchpads or no uri", value: s.outOfScope },
];
</script>

<template>
  <div class="grid gap-10">
    <h2 class="page-title">Study</h2>

    <p v-if="!data" class="surface muted text-sm">No Study figures yet.</p>
    <template v-else>
      <section class="grid gap-3" data-test="study-rule">
        <h3 class="section-title">Capture rule</h3>
        <div class="row row-static">
          <p class="font-semibold">
            Metadata and website Snapshot at {{ minutes(data.rule.snapshotAgeSec) }} after create <span class="faint ml-1 text-sm font-normal">rule v{{ data.rule.version }}</span>
          </p>
          <p class="muted mt-1 text-sm">
            X capture at {{ minutes(data.rule.xCaptureAgeSec) }} · Fast migration: within {{ minutes(data.rule.fastMigrationSec) }} of create · a Snapshot is written once and never edited
          </p>
        </div>
      </section>

      <section v-for="block in [{ id: 'all', title: 'Since the Study started', s: data.allTime }, { id: 'day', title: 'Last 24 hours', s: data.last24h }]" :key="block.id" class="grid gap-3" :data-test="`study-${block.id}`">
        <h3 class="section-title">{{ block.title }}</h3>
        <div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          <article v-for="h in headline(block.s)" :key="h.key" class="row row-static" :data-test="`stat-${h.key}`">
            <p class="eyebrow">{{ h.label }}</p>
            <p class="mt-1 text-3xl font-bold tracking-tight" :data-test="`value-${h.key}`">{{ h.value }}</p>
            <p class="muted mt-1 text-sm">{{ h.note }}</p>
          </article>
        </div>
        <div class="surface grid gap-1.5 text-sm">
          <p v-for="r in rest(block.s)" :key="r.label" class="flex justify-between gap-4">
            <span class="muted">{{ r.label }}</span>
            <span class="font-semibold">{{ r.value }}</span>
          </p>
          <p class="flex justify-between gap-4">
            <span class="muted">PumpPortal gaps (disconnects and restarts)</span>
            <span class="font-semibold">{{ block.s.gapCount }}, {{ dur(block.s.gapSeconds) }} total</span>
          </p>
          <p class="flex justify-between gap-4">
            <span class="muted">Capture runs in the last 24 hours</span>
            <span class="font-semibold">{{ block.s.captureRuns24h }} of {{ block.s.captureRunCap }}</span>
          </p>
        </div>
      </section>
    </template>
  </div>
</template>
