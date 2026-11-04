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
        <p class="mt-2 text-sm text-muted">
          Agent cost: ${{ p.agentCostUsd.toFixed(2) }} · Score: n/a · Collision checks: n/a · Narrative age: n/a
        </p>
      </UCard>
    </section>
  </div>
</template>
