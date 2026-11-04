<script setup lang="ts">
const route = useRoute();
const { data: p } = await useFetch(`/api/proposals/${route.params.id}`);
</script>

<template>
  <UCard v-if="p">
    <template #header>
      <div class="flex items-center justify-between">
        <h2 class="text-xl font-semibold">{{ p.name }} ({{ p.ticker }})</h2>
        <UBadge>{{ p.status }}</UBadge>
      </div>
    </template>
    <dl class="grid gap-2">
      <dt class="font-semibold">Narrative summary</dt>
      <dd>{{ p.narrativeSummary }}</dd>
      <dt class="font-semibold">Tech one-liner</dt>
      <dd>{{ p.techOneLiner }}</dd>
      <dt class="font-semibold">Why now</dt>
      <dd>{{ p.whyNow }}</dd>
      <dt class="font-semibold">Description</dt>
      <dd>{{ p.description }}</dd>
      <dt class="font-semibold">Evidence links</dt>
      <dd>
        <ul>
          <li v-for="link in p.evidenceLinks" :key="link">
            <a :href="link" target="_blank" rel="noopener">{{ link }}</a>
          </li>
        </ul>
      </dd>
      <dt class="font-semibold">Slug</dt>
      <dd>{{ p.slug }}</dd>
      <dt class="font-semibold">Agent cost</dt>
      <dd>${{ p.agentCostUsd.toFixed(2) }}</dd>
      <dt class="font-semibold">Created</dt>
      <dd>{{ p.createdAt }}</dd>
      <dt class="font-semibold">Updated</dt>
      <dd>{{ p.updatedAt }}</dd>
    </dl>
  </UCard>
  <p v-else>Proposal not found.</p>
</template>
