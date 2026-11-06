<script setup lang="ts">
const { data: proposals, refresh } = await useFetch("/api/proposals", { default: () => [] });

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
const clock = setInterval(() => (nowMs.value = Date.now()), 30_000);
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
  } catch (e) {
    error.value = (e as { statusMessage?: string }).statusMessage ?? "Could not create Proposal";
  }
}
</script>

<template>
  <div class="space-y-8">
    <UCard>
      <template #header>New Proposal</template>
      <form class="grid gap-3" @submit.prevent="submit">
        <UInput v-model="form.name" placeholder="Name" />
        <UInput v-model="form.ticker" placeholder="Ticker" />
        <UTextarea v-model="form.narrativeSummary" placeholder="Narrative summary" />
        <UInput v-model="form.techOneLiner" placeholder="Tech one-liner" />
        <UInput v-model="form.whyNow" placeholder="Why now" />
        <UTextarea v-model="form.description" placeholder="Description" />
        <UTextarea v-model="form.evidenceLinks" placeholder="Evidence links, one per line" />
        <p v-if="error" class="text-sm text-red-500">{{ error }}</p>
        <UButton type="submit">Create Proposal</UButton>
      </form>
    </UCard>

    <UCard v-if="research" data-test="research-usage">
      <template #header>Research usage, last 24 hours</template>
      <p class="text-sm">
        <span title="API-equivalent estimate reported by claude -p. Runs use the Claude subscription; this is not a charge.">Est. usage (API-equiv.)</span>:
        ${{ research.usedUsd.toFixed(2) }} of ${{ research.budgetUsd.toFixed(2) }} research budget
        ({{ Math.round(research.usedShareOfQuota * 100) }}% of an assumed ${{ research.quotaUsd.toFixed(0) }} daily quota; the limit is {{ Math.round(research.share * 100) }}%)
        over {{ research.runs }} judge and propose {{ research.runs === 1 ? "run" : "runs" }}.
      </p>
      <p v-if="research.exhausted" class="mt-1 text-sm text-amber-500">Research budget reached: judging and proposing wait until older runs leave the 24 hours.</p>
      <p class="mt-1 text-sm">New Proposals: {{ research.newProposals }} of {{ research.newProposalsCap }} a day<template v-if="research.newProposals >= research.newProposalsCap"> (cap reached; the next waits for the day to roll over)</template>.</p>
    </UCard>

    <UCard>
      <template #header>Latest Signals</template>
      <p v-if="!signals.length" class="text-sm text-muted">No Signals yet. The worker polls its Sources (RSS, Google Trends, DexScreener) every 5 minutes.</p>
      <ul class="grid gap-1 text-sm">
        <li v-for="s in signals" :key="s.id" class="flex flex-wrap items-baseline gap-x-2">
          <UBadge variant="subtle" size="sm">{{ s.sourceLabel }}</UBadge>
          <a v-if="s.url" :href="s.url" target="_blank" rel="noopener noreferrer">{{ s.title }}</a>
          <span v-else>{{ s.title }}</span>
          <time class="text-muted" :datetime="s.publishedAt">{{ new Date(s.publishedAt).toLocaleString() }}</time>
        </li>
      </ul>
    </UCard>

    <section class="grid gap-4">
      <p v-if="!proposals.length">No Proposals yet.</p>
      <UCard v-for="p in proposals" :key="p.id">
        <div class="flex items-center justify-between">
          <NuxtLink :to="`/proposals/${p.id}`" class="font-semibold">{{ p.name }} ({{ p.ticker }})</NuxtLink>
          <UBadge>{{ p.status }}</UBadge>
        </div>
        <p class="mt-2 line-clamp-2 whitespace-pre-line">{{ p.narrativeSummary }}</p>
        <p class="text-sm"><strong>Tech:</strong> {{ p.techOneLiner }}</p>
        <p class="text-sm"><strong>Why now:</strong> {{ p.whyNow }}</p>
        <div v-if="p.score" class="mt-2">
          <ScoreBars :scores="p.score.scores" :total="p.score.total" />
        </div>
        <ul class="mt-2 text-sm">
          <li v-for="link in p.evidenceLinks" :key="link">
            <a :href="link" target="_blank" rel="noopener">{{ link }}</a>
          </li>
        </ul>
        <CollisionChecks class="mt-2" :collisions="p.collisions" />
        <p v-if="p.expiresAt" class="mt-2 text-sm text-muted" data-test="time-left">{{ timeLeft(p.expiresAt) }}</p>
        <p v-if="p.brainRunInFlightSince" class="mt-2 text-sm text-amber-500">
          Brain run in flight since {{ p.brainRunInFlightSince }}. If the worker is not running, it was interrupted and its spend is unknown; restart the worker to flag it.
        </p>
        <p v-if="p.specError" class="mt-2 text-sm text-red-500">{{ p.specError }}</p>
        <p v-if="p.previewUrl" class="mt-2 text-sm">Preview: <a :href="p.previewUrl" target="_blank" rel="noopener">{{ p.previewUrl }}</a></p>
        <div v-if="p.status === 'build-failed'" class="mt-2 text-sm">
          <p class="text-red-500">The Build failed after its retry.</p>
          <template v-if="p.resumeCommand">
            <p>To continue its session, run in tmux on the host:</p>
            <pre class="overflow-auto whitespace-pre-wrap text-xs">{{ p.resumeCommand }}</pre>
          </template>
          <p class="text-muted">Re-queue starts a fresh Build: first remove ~/code/{{ p.slug }}, the private GitHub repo {{ p.slug }}<template v-if="p.workerDeployed"> and the Cloudflare Worker {{ p.slug }} (the Build deployed it)</template>. Re-queue is refused while the directory or the repo is still there.</p>
        </div>
        <p v-if="rejection(p)" class="mt-2 text-sm text-red-500">
          Command {{ rejection(p)!.status }}: {{ rejection(p)!.error }}
        </p>
        <p v-if="retrying(p.id)" class="mt-2 text-sm text-amber-500">
          Command retrying ({{ retrying(p.id)!.attempts }}/5): {{ retrying(p.id)!.error }}
        </p>
        <p v-else-if="pendingIds.has(p.id)" class="mt-2 text-sm text-muted">Command pending...</p>
        <div v-if="p.status !== 'closed' && p.status !== 'dismissed'" class="mt-2 flex flex-wrap items-center gap-2">
          <UButton v-if="p.status === 'new'" size="sm" :disabled="busy(p.id)" @click="send(p.id, 'shortlist')">Shortlist</UButton>
          <UButton
            v-if="p.status === 'shortlisted' && p.specError"
            size="sm"
            :disabled="busy(p.id) || !!p.brainRunInFlightSince"
            @click="send(p.id, 'retry-spec')"
          >
            Retry Spec
          </UButton>
          <UButton v-if="p.status === 'spec-drafted'" size="sm" variant="outline" :to="`/proposals/${p.id}`">Edit Spec</UButton>
          <UButton v-if="p.status === 'build-failed'" size="sm" :disabled="busy(p.id)" @click="send(p.id, 'requeue')">Re-queue</UButton>
          <UButton v-if="dismissing !== p.id" size="sm" color="neutral" variant="outline" :disabled="busy(p.id)" @click="dismissing = p.id">
            Dismiss
          </UButton>
          <template v-else>
            <UInput v-model="dismissReason" size="sm" placeholder="Reason" />
            <UButton size="sm" color="error" :disabled="!dismissReason.trim() || busy(p.id)" @click="send(p.id, 'dismiss', dismissReason)">
              Confirm dismiss
            </UButton>
            <UButton size="sm" variant="ghost" @click="dismissing = null">Cancel</UButton>
          </template>
        </div>
        <p v-if="dismissing === p.id && actionError" class="text-sm text-red-500">{{ actionError }}</p>
        <p class="mt-2 text-sm text-muted">
          <span title="API-equivalent estimate reported by claude -p. Runs use the Claude subscription; this is not a charge.">Est. usage (API-equiv.): ${{ p.agentCostUsd.toFixed(2) }}</span> · Score: {{ p.score ? `${p.score.total.toFixed(1)} / 10` : "n/a" }} · Collision checks: n/a · Narrative age: <span data-test="narrative-age">{{ p.narrativeCreatedAt ? narrativeAge(p.narrativeCreatedAt) : "n/a" }}</span>
        </p>
      </UCard>
    </section>
  </div>
</template>
