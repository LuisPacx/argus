<script setup lang="ts">
const route = useRoute();
const { data: n } = await useFetch(`/api/narratives/${route.params.id}`);
</script>

<template>
  <div v-if="n" class="space-y-4">
    <NuxtLink to="/narratives" class="text-sm">Back to Narratives</NuxtLink>
    <h2 class="text-xl font-semibold">{{ n.title }}</h2>
    <p v-if="n.summary" class="text-sm">{{ n.summary }}</p>
    <p class="text-sm text-muted">
      {{ n.signalCount }} {{ n.signalCount === 1 ? "Signal" : "Signals" }} · started {{ new Date(n.createdAt).toLocaleString() }} · last Signal
      {{ new Date(n.lastSignalAt).toLocaleString() }} · last material change {{ new Date(n.changedMateriallyAt).toLocaleString() }}
    </p>
    <UCard>
      <template #header>Signals</template>
      <ul class="grid gap-1 text-sm">
        <li v-for="s in n.signals" :key="s.id" class="flex flex-wrap items-baseline gap-x-2">
          <UBadge variant="subtle" size="sm">{{ s.sourceLabel }}</UBadge>
          <a v-if="s.url" :href="s.url" target="_blank" rel="noopener noreferrer">{{ s.title }}</a>
          <span v-else>{{ s.title }}</span>
          <time class="text-muted" :datetime="s.publishedAt">{{ new Date(s.publishedAt).toLocaleString() }}</time>
        </li>
      </ul>
    </UCard>
  </div>
  <p v-else>Narrative not found.</p>
</template>
