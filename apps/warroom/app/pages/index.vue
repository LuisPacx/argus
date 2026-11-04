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

const dismissing = ref<number | null>(null);
const dismissReason = ref("");
const actionError = ref("");
const pendingIds = computed(() => new Set(commands.value.filter((c) => c.status === "pending").map((c) => c.proposalId)));
// Newest command per Proposal, shown only when the worker rejected it.
const rejection = (id: number) => {
  const latest = commands.value.find((c) => c.proposalId === id);
  return latest?.status === "rejected" ? latest : undefined;
};

async function send(id: number, type: "shortlist" | "dismiss", reason = "") {
  actionError.value = "";
  try {
    await $fetch(`/api/proposals/${id}/commands`, { method: "POST", body: { type, reason } });
    dismissing.value = null;
    dismissReason.value = "";
    await refreshCommands();
  } catch (e) {
    actionError.value = (e as { statusMessage?: string }).statusMessage ?? "Could not send command";
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
        <p v-if="rejection(p.id)" class="mt-2 text-sm text-red-500">
          Command rejected: {{ rejection(p.id)!.error }}
        </p>
        <p v-if="pendingIds.has(p.id)" class="mt-2 text-sm text-muted">Command pending...</p>
        <div v-if="p.status !== 'closed' && p.status !== 'dismissed'" class="mt-2 flex flex-wrap items-center gap-2">
          <UButton v-if="p.status === 'new'" size="sm" @click="send(p.id, 'shortlist')">Shortlist</UButton>
          <UButton v-if="dismissing !== p.id" size="sm" color="neutral" variant="outline" @click="dismissing = p.id">
            Dismiss
          </UButton>
          <template v-else>
            <UInput v-model="dismissReason" size="sm" placeholder="Reason" />
            <UButton size="sm" color="error" :disabled="!dismissReason.trim()" @click="send(p.id, 'dismiss', dismissReason)">
              Confirm dismiss
            </UButton>
            <UButton size="sm" variant="ghost" @click="dismissing = null">Cancel</UButton>
          </template>
        </div>
        <p v-if="dismissing === p.id && actionError" class="text-sm text-red-500">{{ actionError }}</p>
        <p class="mt-2 text-sm text-muted">
          Agent cost: ${{ p.agentCostUsd.toFixed(2) }} · Score: n/a · Collision checks: n/a · Narrative age: n/a
        </p>
      </UCard>
    </section>
  </div>
</template>
