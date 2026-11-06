<script setup lang="ts">
const { data: narratives, refresh } = await useFetch("/api/narratives", { default: () => [] });
let timer: ReturnType<typeof setInterval> | undefined;
onMounted(() => {
  timer = setInterval(() => void refresh(), 10_000);
});
onBeforeUnmount(() => clearInterval(timer));

const nowMs = ref(Date.now());
const clock = setInterval(() => (nowMs.value = Date.now()), 30_000);
onBeforeUnmount(() => clearInterval(clock));
const age = (createdAt: string) => {
  const mins = Math.max(0, Math.floor((nowMs.value - new Date(createdAt).getTime()) / 60_000));
  if (mins < 60) return `${mins} min`;
  const hours = Math.floor(mins / 60);
  return hours < 48 ? `${hours} h` : `${Math.floor(hours / 24)} d`;
};
</script>

<template>
  <div class="space-y-4">
    <h2 class="text-xl font-semibold">Narratives</h2>
    <p v-if="!narratives.length" class="text-sm text-muted">No Narratives yet. The worker clusters new Signals after each ingest tick.</p>
    <UCard v-for="n in narratives" :key="n.id">
      <NuxtLink :to="`/narratives/${n.id}`" class="font-semibold">{{ n.title }}</NuxtLink>
      <p v-if="n.summary" class="line-clamp-1 text-sm">{{ n.summary }}</p>
      <p class="mt-2 text-sm text-muted">
        <span data-test="signal-count">{{ n.signalCount }} {{ n.signalCount === 1 ? "Signal" : "Signals" }}</span> ·
        <span data-test="age">age {{ age(n.createdAt) }}</span>
      </p>
    </UCard>
  </div>
</template>
