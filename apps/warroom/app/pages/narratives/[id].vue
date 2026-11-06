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
      <template #header>Score history</template>
      <p v-if="n.scores.length === 0" class="text-sm text-muted">Not scored yet. The judge scores new and materially changed Narratives every 30 minutes.</p>
      <ol v-else class="grid gap-3 text-sm" data-testid="score-history">
        <li v-for="s in n.scores" :key="s.id" class="grid gap-1">
          <div class="flex flex-wrap items-baseline gap-x-2">
            <strong>{{ s.total.toFixed(1) }} / 10</strong>
            <UBadge variant="subtle" size="sm">Rubric v{{ s.rubricVersion }}</UBadge>
            <time class="text-muted" :datetime="s.createdAt">{{ new Date(s.createdAt).toLocaleString() }}</time>
            <span class="text-muted">{{ s.signalCount }} {{ s.signalCount === 1 ? "Signal" : "Signals" }}</span>
          </div>
          <div class="flex flex-wrap gap-x-4 gap-y-1">
            <span v-for="(value, key) in s.scores" :key="key">{{ key }} {{ value }}</span>
          </div>
          <p class="text-muted">{{ s.rationale }}</p>
        </li>
      </ol>
    </UCard>
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
