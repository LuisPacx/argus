<script setup lang="ts">
const route = useRoute();
const { data: proposals, refresh } = await useFetch("/api/proposals", { default: () => [] });

// Rows animate in when the page is reached by a client navigation; on the first (hydrating) load they are simply there.
const animate = !useNuxtApp().isHydrating;

// The header's New Proposal button links to /?new=1, which opens the form above the summary band.
const showForm = computed(() => route.query.new !== undefined);

const blank = () => ({
  name: "",
  ticker: "",
  narrativeSummary: "",
  techOneLiner: "",
  whyNow: "",
  description: "",
  evidenceLinks: "",
});
const form = reactive(blank());
const error = ref("");

const { data: commands, refresh: refreshCommands } = await useFetch("/api/commands", { default: () => [] });
const { data: signals, refresh: refreshSignals } = await useFetch("/api/signals", { default: () => [] });
const { data: research, refresh: refreshResearch } = await useFetch("/api/research");
let timer: ReturnType<typeof setInterval> | undefined;
onMounted(() => {
  timer = setInterval(() => void Promise.all([refresh(), refreshCommands(), refreshSignals(), refreshResearch()]), 3000);
});
onBeforeUnmount(() => clearInterval(timer));

const nowMs = ref(Date.now());
let clock: ReturnType<typeof setInterval> | undefined;
onMounted(() => {
  clock = setInterval(() => (nowMs.value = Date.now()), 30_000);
});
onBeforeUnmount(() => clearInterval(clock));
// Time left before a stale Proposal closes itself (the worker closes it; a Brain run in flight holds it off).
const timeLeft = (expiresAt: string) => {
  const mins = Math.floor((new Date(expiresAt).getTime() - nowMs.value) / 60_000);
  if (mins <= 0) return "Expires on the next worker tick";
  if (mins < 60) return `Expires in ${mins} min`;
  const hours = Math.floor(mins / 60);
  return hours < 48 ? `Expires in ${hours} h` : `Expires in ${Math.floor(hours / 24)} d ${hours % 24} h`;
};

// How long ago a Narrative started (the card's Narrative age).
const narrativeAge = (since: string) => {
  const mins = Math.max(0, Math.floor((nowMs.value - new Date(since).getTime()) / 60_000));
  if (mins < 60) return `${mins} min`;
  const hours = Math.floor(mins / 60);
  return hours < 48 ? `${hours} h` : `${Math.floor(hours / 24)} d ${hours % 24} h`;
};

const dismissing = ref<number | null>(null);
const dismissReason = ref("");
const actionError = ref("");
const pendingIds = computed(() => new Set(commands.value.filter((c) => c.status === "pending").map((c) => c.proposalId)));
// Proposals with a command being posted, so a fast second click cannot enqueue a duplicate.
const sending = ref(new Set<number>());
const busy = (id: number) => pendingIds.value.has(id) || sending.value.has(id);
// Newest command per Proposal, shown only when the worker rejected it or gave up (failed) and the Proposal has not
// changed status since (a stale rejection clears itself).
const rejection = (p: { id: number; updatedAt: string }) => {
  const latest = commands.value.find((c) => c.proposalId === p.id);
  return (latest?.status === "rejected" || latest?.status === "failed") && (latest.appliedAt ?? "") > p.updatedAt ? latest : undefined;
};

const retrying = (id: number) => commands.value.find((c) => c.proposalId === id && c.status === "pending" && c.attempts > 0);

async function send(id: number, type: "shortlist" | "dismiss" | "retry-spec" | "requeue", reason = "") {
  if (busy(id)) return;
  actionError.value = "";
  sending.value.add(id);
  try {
    await $fetch(`/api/proposals/${id}/commands`, { method: "POST", body: { type, reason } });
    dismissing.value = null;
    dismissReason.value = "";
    await refreshCommands();
  } catch (e) {
    actionError.value = (e as { statusMessage?: string }).statusMessage ?? "Could not send command";
  } finally {
    sending.value.delete(id);
  }
}

async function submit() {
  error.value = "";
  try {
    await $fetch("/api/proposals", {
      method: "POST",
      body: { ...form, evidenceLinks: form.evidenceLinks.split("\n") },
    });
    Object.assign(form, blank());
    await refresh();
    await navigateTo("/");
  } catch (e) {
    error.value = (e as { statusMessage?: string }).statusMessage ?? "Could not create Proposal";
  }
}

const newCount = computed(() => proposals.value.filter((p) => p.status === "new").length);
const pct = (used: number, of: number) => (of > 0 ? Math.min(100, (used / of) * 100) : 0);
// Whether a row has anything to say under its main line.
const hasNotes = (p: (typeof proposals.value)[number]) =>
  !!(p.brainRunInFlightSince || p.specError || p.previewUrl || p.status === "build-failed" || rejection(p) || pendingIds.value.has(p.id) || (dismissing.value === p.id && actionError.value));
</script>

<template>
  <div class="grid gap-8">
    <div>
      <h2 class="page-title">Proposals</h2>
      <p class="page-sub">{{ proposals.length }} {{ proposals.length === 1 ? "Proposal" : "Proposals" }}, {{ newCount }} new</p>
    </div>

    <Transition name="reveal">
      <section v-if="showForm" class="surface" data-test="new-proposal-form">
        <div class="mb-4 flex items-center justify-between">
          <h3 class="section-title">New Proposal</h3>
          <NuxtLink to="/" class="btn btn-ghost">Cancel</NuxtLink>
        </div>
        <form class="grid gap-3" @submit.prevent="submit">
          <div class="grid gap-3 sm:grid-cols-[2fr_1fr]">
            <input v-model="form.name" class="field" placeholder="Name" />
            <input v-model="form.ticker" class="field" placeholder="Ticker" />
          </div>
          <textarea v-model="form.narrativeSummary" class="field" rows="3" placeholder="Narrative summary" />
          <input v-model="form.techOneLiner" class="field" placeholder="Tech one-liner" />
          <input v-model="form.whyNow" class="field" placeholder="Why now" />
          <textarea v-model="form.description" class="field" rows="3" placeholder="Description" />
          <textarea v-model="form.evidenceLinks" class="field" rows="3" placeholder="Evidence links, one per line" />
          <p v-if="error" class="note note-red">{{ error }}</p>
          <div><button type="submit" class="btn btn-primary">Create Proposal</button></div>
        </form>
      </section>
    </Transition>

    <section class="grid gap-5 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
      <div v-if="research" class="surface grid content-start gap-4" data-test="research-usage">
        <h3 class="section-title">Research usage, last 24 hours</h3>
        <div class="grid gap-1.5">
          <div class="flex items-baseline justify-between gap-3 text-sm">
            <span class="muted" title="API-equivalent estimate reported by claude -p. Runs use the Claude subscription; this is not a charge.">Budget (est. usage, API-equiv.)</span>
            <span class="font-semibold tabular-nums">${{ research.usedUsd.toFixed(2) }} of ${{ research.budgetUsd.toFixed(2) }}</span>
          </div>
          <div class="track" role="progressbar" :aria-valuenow="Math.round(pct(research.usedUsd, research.budgetUsd))" aria-valuemin="0" aria-valuemax="100">
            <div class="fill" :class="{ 'fill-bad': research.exhausted }" :style="{ width: `${pct(research.usedUsd, research.budgetUsd)}%`, '--i': 0 }" />
          </div>
        </div>
        <div class="grid gap-1.5">
          <div class="flex items-baseline justify-between gap-3 text-sm">
            <span class="muted">New Proposals a day</span>
            <span class="font-semibold tabular-nums">{{ research.newProposals }} of {{ research.newProposalsCap }}</span>
          </div>
          <div class="track" role="progressbar" :aria-valuenow="Math.round(pct(research.newProposals, research.newProposalsCap))" aria-valuemin="0" aria-valuemax="100">
            <div class="fill" :style="{ width: `${pct(research.newProposals, research.newProposalsCap)}%`, '--i': 1 }" />
          </div>
          <p v-if="research.newProposals >= research.newProposalsCap" class="note faint">Cap reached; the next waits for the day to roll over.</p>
        </div>
        <p class="note faint">
          {{ research.runs }} judge and propose {{ research.runs === 1 ? "run" : "runs" }}, {{ Math.round(research.usedShareOfQuota * 100) }}% of an assumed
          ${{ research.quotaUsd.toFixed(0) }} daily quota; the limit is {{ Math.round(research.share * 100) }}%.
        </p>
        <p v-if="research.exhausted" class="note note-amber">Research budget reached: judging and proposing wait until older runs leave the 24 hours.</p>
        <p class="note muted" data-test="api-spend">
          <span title="Real money billed by the Anthropic API, unlike Est. usage above. Only the API fallback spends it, when the subscription is rate-limited.">API spend (real $)</span>:
          ${{ research.api.usedUsd.toFixed(4) }} of ${{ research.api.capUsd.toFixed(2) }} daily cap over {{ research.api.runs }} {{ research.api.runs === 1 ? "run" : "runs" }}
          <template v-if="!research.api.enabled">(fallback off: set ARGUS_API_FALLBACK=1 and ANTHROPIC_API_KEY in .env to turn it on)</template>
        </p>
        <p v-if="research.api.exhausted" class="note note-amber">API daily cap reached: the fallback sends nothing until older spend leaves the 24 hours.</p>
      </div>

      <div class="surface grid content-start gap-4" :class="{ 'lg:col-span-2': !research }">
        <h3 class="section-title">Latest Signals</h3>
        <p v-if="!signals.length" class="note muted">No Signals yet. The worker polls its Sources (RSS, Google Trends, DexScreener) every 5 minutes.</p>
        <ul class="grid max-h-[13.5rem] gap-x-6 gap-y-4 overflow-y-auto pr-1 sm:grid-cols-2 xl:grid-cols-3">
          <li v-for="s in signals" :key="s.id" class="grid min-w-0 content-start gap-1.5 text-sm">
            <div class="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span class="pill">{{ s.sourceLabel }}</span>
              <time class="faint text-xs" :datetime="s.publishedAt">{{ fmtWhen(s.publishedAt) }}</time>
            </div>
            <a v-if="s.url" class="link line-clamp-2" :href="s.url" :title="s.title" target="_blank" rel="noopener noreferrer">{{ s.title }}</a>
            <span v-else class="line-clamp-2" :title="s.title">{{ s.title }}</span>
          </li>
        </ul>
      </div>
    </section>

    <section>
      <p v-if="!proposals.length" class="surface muted text-sm">No Proposals yet.</p>
      <TransitionGroup v-else tag="div" name="row" :appear="animate" class="relative grid gap-4">
        <article v-for="(p, i) in proposals" :key="p.id" class="row" :style="{ '--i': i }" :data-test="`proposal-${p.id}`">
          <div class="grid items-center gap-x-6 gap-y-4 lg:grid-cols-[minmax(0,1.4fr)_250px_150px_150px_auto]">
            <div class="min-w-0">
              <div class="flex flex-wrap items-center gap-x-2.5 gap-y-1">
                <h3 class="text-lg font-semibold leading-tight tracking-tight">
                  <NuxtLink :to="`/proposals/${p.id}`" class="row-link">{{ p.name }}</NuxtLink>
                </h3>
                <span class="faint text-xs font-medium uppercase tracking-wide">{{ p.ticker }}</span>
                <StatusPill :status="p.status" />
              </div>
              <p class="muted mt-2 line-clamp-3 whitespace-pre-line text-sm leading-relaxed">{{ p.narrativeSummary }}</p>
            </div>

            <div class="flex items-center gap-4">
              <template v-if="p.score">
                <span class="pill pill-accent shrink-0 px-3 py-2 text-base tabular-nums">{{ p.score.total.toFixed(1) }}<span class="text-xs font-medium opacity-70">/10</span></span>
                <ScoreBars class="min-w-0 grow" compact :scores="p.score.scores" />
              </template>
              <span v-else class="faint text-sm">No score</span>
            </div>

            <CollisionChecks pills class="above" :collisions="p.collisions" />

            <div class="muted grid gap-1 text-xs">
              <span>Narrative age: <span data-test="narrative-age">{{ p.narrativeCreatedAt ? narrativeAge(p.narrativeCreatedAt) : "n/a" }}</span></span>
              <span v-if="p.expiresAt" data-test="time-left">{{ timeLeft(p.expiresAt) }}</span>
              <span><span class="above" title="API-equivalent estimate reported by claude -p. Runs use the Claude subscription; this is not a charge.">Est. usage (API-equiv.): ${{ p.agentCostUsd.toFixed(2) }}</span></span>
            </div>

            <div v-if="p.status !== 'closed' && p.status !== 'dismissed'" class="above flex flex-wrap items-center gap-2 lg:justify-end">
              <button v-if="p.status === 'new'" class="btn btn-primary" :disabled="busy(p.id)" @click="send(p.id, 'shortlist')">Shortlist</button>
              <button v-if="p.status === 'shortlisted' && p.specError" class="btn btn-primary" :disabled="busy(p.id) || !!p.brainRunInFlightSince" @click="send(p.id, 'retry-spec')">
                Retry Spec
              </button>
              <NuxtLink v-if="p.status === 'spec-drafted'" class="btn btn-primary" :to="`/proposals/${p.id}`">Edit Spec</NuxtLink>
              <button v-if="p.status === 'build-failed'" class="btn btn-primary" :disabled="busy(p.id)" @click="send(p.id, 'requeue')">Re-queue</button>
              <button v-if="dismissing !== p.id" class="btn" :disabled="busy(p.id)" @click="dismissing = p.id">Dismiss</button>
              <template v-else>
                <input v-model="dismissReason" class="field field-sm w-44" placeholder="Reason" />
                <button class="btn btn-danger" :disabled="!dismissReason.trim() || busy(p.id)" @click="send(p.id, 'dismiss', dismissReason)">Confirm dismiss</button>
                <button class="btn btn-ghost" @click="dismissing = null">Cancel</button>
              </template>
            </div>
            <div v-else class="hidden lg:block" />
          </div>

          <div v-if="hasNotes(p)" class="above mt-4 grid gap-2 border-t border-[var(--wr-line)] pt-4 text-sm">
            <p v-if="p.brainRunInFlightSince" class="note note-amber">
              Brain run in flight since {{ p.brainRunInFlightSince }}. If the worker is not running, it was interrupted and its spend is unknown; restart the worker to flag it.
            </p>
            <p v-if="p.specError" class="note note-red">{{ p.specError }}</p>
            <p v-if="p.previewUrl" class="note flex min-w-0 items-center gap-2">Preview: <UrlLink :href="p.previewUrl" /></p>
            <div v-if="p.status === 'build-failed'" class="note grid gap-1.5">
              <p class="note-red">The Build failed after its retry.</p>
              <template v-if="p.resumeCommand">
                <p>To continue its session, run in tmux on the host:</p>
                <pre class="inset overflow-auto whitespace-pre-wrap p-3 text-xs">{{ p.resumeCommand }}</pre>
              </template>
              <p class="muted">Re-queue starts a fresh Build: first remove ~/code/{{ p.slug }}, the private GitHub repo {{ p.slug }}<template v-if="p.workerDeployed"> and the Cloudflare Worker {{ p.slug }} (the Build deployed it)</template>. Re-queue is refused while the directory or the repo is still there.</p>
            </div>
            <p v-if="rejection(p)" class="note note-red">Command {{ rejection(p)!.status }}: {{ rejection(p)!.error }}</p>
            <p v-if="retrying(p.id)" class="note note-amber">Command retrying ({{ retrying(p.id)!.attempts }}/5): {{ retrying(p.id)!.error }}</p>
            <p v-else-if="pendingIds.has(p.id)" class="note muted">Command pending...</p>
            <p v-if="dismissing === p.id && actionError" class="note note-red">{{ actionError }}</p>
          </div>
        </article>
      </TransitionGroup>
    </section>
  </div>
</template>
