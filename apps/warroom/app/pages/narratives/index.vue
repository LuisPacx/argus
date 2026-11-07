<script setup lang="ts">
const route = useRoute();

// Sort and filters live in the URL query (and are applied by the API, so a cap cuts after sorting). Defaults are left out of the URL.
const SORTS = [
  { value: "score", label: "Score" },
  { value: "newest", label: "Newest" },
  { value: "signals", label: "Most Signals" },
  { value: "active", label: "Last Signal" },
];
const SCORED = [
  { value: "", label: "All" },
  { value: "yes", label: "Scored" },
  { value: "no", label: "Unscored" },
];
const PROPOSAL = [
  { value: "", label: "Any" },
  { value: "yes", label: "Has Proposal" },
  { value: "no", label: "No Proposal" },
];
const ACTIVE = [
  { value: "", label: "Any time" },
  { value: "1h", label: "Last hour" },
  { value: "6h", label: "6 hours" },
  { value: "24h", label: "24 hours" },
  { value: "7d", label: "7 days" },
];
const { data: sources } = await useFetch("/api/activity/sources", { default: () => [] });
const pick = (raw: unknown, allowed: Array<{ value: string }>) => {
  const v = typeof raw === "string" ? raw : "";
  return allowed.some((o) => o.value === v) ? v : "";
};
type Current = { sort: string; scored: string; proposal: string; active: string; source: string };
const current = computed<Current>(() => ({
  sort: pick(route.query.sort, SORTS) || "score",
  scored: pick(route.query.scored, SCORED),
  proposal: pick(route.query.proposal, PROPOSAL),
  active: pick(route.query.active, ACTIVE),
  // An unknown Source in the URL falls back to all Sources, like the other controls.
  source: typeof route.query.source === "string" && sources.value.some((s) => s.sourceId === route.query.source) ? route.query.source : "",
}));
const withDefaults = (c: Current) => {
  const q: Record<string, string> = {};
  if (c.sort !== "score") q.sort = c.sort;
  for (const k of ["scored", "proposal", "active", "source"] as const) if (c[k]) q[k] = c[k];
  return q;
};
const to = (patch: Partial<Current>) => ({ path: "/narratives", query: withDefaults({ ...current.value, ...patch }) });
const opts = (list: Array<{ value: string; label: string }>, key: keyof Current) =>
  list.map((o) => ({ label: o.label, to: to({ [key]: o.value }), active: current.value[key] === o.value }));
const filtered = computed(() => !!(current.value.scored || current.value.proposal || current.value.active || current.value.source));
const clearTo = computed(() => to({ scored: "", proposal: "", active: "", source: "" }));

const { data: narratives, refresh } = await useFetch("/api/narratives", { query: computed(() => withDefaults(current.value)), default: () => [] });
const LIMIT = 100;

// Rows animate in when the page is reached by a client navigation; on the first (hydrating) load they are simply there.
const animate = !useNuxtApp().isHydrating;
let timer: ReturnType<typeof setInterval> | undefined;
onMounted(() => {
  timer = setInterval(() => void refresh(), 10_000);
});
onBeforeUnmount(() => clearInterval(timer));

const nowMs = ref(Date.now());
let clock: ReturnType<typeof setInterval> | undefined;
onMounted(() => {
  clock = setInterval(() => (nowMs.value = Date.now()), 30_000);
});
onBeforeUnmount(() => clearInterval(clock));
const age = (createdAt: string) => {
  const mins = Math.max(0, Math.floor((nowMs.value - new Date(createdAt).getTime()) / 60_000));
  if (mins < 60) return `${mins} min`;
  const hours = Math.floor(mins / 60);
  return hours < 48 ? `${hours} h` : `${Math.floor(hours / 24)} d`;
};
const choose = (key: keyof Current, e: Event) => void navigateTo(to({ [key]: (e.target as HTMLSelectElement).value }), { replace: true });
</script>

<template>
  <div class="grid gap-8">
    <h2 class="page-title">Narratives</h2>

    <div class="flex flex-wrap items-end gap-x-4 gap-y-4" data-test="narrative-controls">
      <div class="grid gap-1.5">
        <span class="eyebrow">Sort</span>
        <SegmentedLinks label="Sort" :options="opts(SORTS, 'sort')" />
      </div>
      <div class="grid gap-1.5">
        <span class="eyebrow">Score</span>
        <SegmentedLinks label="Scored filter" :options="opts(SCORED, 'scored')" />
      </div>
      <div class="grid gap-1.5">
        <span class="eyebrow">Proposal</span>
        <SegmentedLinks label="Proposal filter" :options="opts(PROPOSAL, 'proposal')" />
      </div>
      <div class="grid gap-1.5">
        <label class="eyebrow" for="narrative-active">Active</label>
        <select id="narrative-active" class="select-pill" :value="current.active" @change="choose('active', $event)">
          <option v-for="o in ACTIVE" :key="o.value" :value="o.value" :selected="o.value === current.active">{{ o.label }}</option>
        </select>
      </div>
      <div class="grid gap-1.5">
        <label class="eyebrow" for="narrative-source">Source</label>
        <select id="narrative-source" class="select-pill max-w-56" :value="current.source" @change="choose('source', $event)">
          <option value="" :selected="!current.source">All Sources</option>
          <option v-for="s in sources" :key="s.sourceId" :value="s.sourceId" :selected="s.sourceId === current.source">{{ s.label }}</option>
        </select>
      </div>
      <NuxtLink v-if="filtered" :to="clearTo" replace class="btn btn-ghost">Clear filters</NuxtLink>
    </div>

    <p v-if="!narratives.length && filtered" class="surface muted text-sm">No Narratives match these filters.</p>
    <p v-else-if="!narratives.length" class="surface muted text-sm">No Narratives yet. The worker clusters new Signals after each ingest tick.</p>
    <TransitionGroup v-else tag="div" name="row" :appear="animate" class="relative grid gap-3">
      <article v-for="(n, i) in narratives" :key="n.id" class="row flex items-center gap-4 py-5" :style="{ '--i': i }">
        <div class="min-w-0 grow">
          <h3 class="truncate font-semibold tracking-tight">
            <NuxtLink :to="`/narratives/${n.id}`" class="row-link">{{ n.title }}</NuxtLink>
          </h3>
          <p v-if="n.summary" class="muted mt-1 line-clamp-1 text-sm">{{ n.summary }}</p>
        </div>
        <div class="flex shrink-0 items-center gap-3 text-sm">
          <span v-if="n.hasProposal" class="pill pill-green" data-test="has-proposal">Proposal</span>
          <span v-if="n.score !== null" class="pill pill-accent tabular-nums" data-test="score">{{ n.score.toFixed(1) }}<span class="opacity-70">/10</span></span>
          <span class="pill pill-ink" data-test="signal-count">{{ signalsLabel(n.signalCount) }}</span>
          <span class="faint hidden w-24 text-right sm:inline" data-test="age">age {{ age(n.createdAt) }}</span>
          <svg class="size-4 shrink-0 text-[var(--wr-faint)]" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 3 5 5-5 5" /></svg>
        </div>
      </article>
    </TransitionGroup>
    <p v-if="narratives.length >= LIMIT" class="faint text-center text-xs">Showing the first {{ LIMIT }}.</p>
  </div>
</template>
