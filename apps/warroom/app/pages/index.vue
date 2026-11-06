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
let timer: ReturnType<typeof setInterval> | undefined;
onMounted(() => {
  timer = setInterval(() => void Promise.all([refresh(), refreshCommands()]), 3000);
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

    <section class="grid gap-4">
      <p v-if="!proposals.length">No Proposals yet.</p>
      <UCard v-for="p in proposals" :key="p.id">
        <div class="flex items-center justify-between">
          <NuxtLink :to="`/proposals/${p.id}`" class="font-semibold">{{ p.name }} ({{ p.ticker }})</NuxtLink>
          <UBadge>{{ p.status }}</UBadge>
        </div>
        <p class="mt-2 line-clamp-2">{{ p.narrativeSummary }}</p>
        <p class="text-sm"><strong>Tech:</strong> {{ p.techOneLiner }}</p>
        <p class="text-sm"><strong>Why now:</strong> {{ p.whyNow }}</p>
        <ul class="mt-2 text-sm">
          <li v-for="link in p.evidenceLinks" :key="link">
            <a :href="link" target="_blank" rel="noopener">{{ link }}</a>
          </li>
        </ul>
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
          <span title="API-equivalent estimate reported by claude -p. Runs use the Claude subscription; this is not a charge.">Est. usage (API-equiv.): ${{ p.agentCostUsd.toFixed(2) }}</span> · Score: n/a · Collision checks: n/a · Narrative age: n/a
        </p>
      </UCard>
    </section>
  </div>
</template>
