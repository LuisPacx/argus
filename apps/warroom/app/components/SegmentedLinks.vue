<script setup lang="ts">
// A soft pill group where each option is a link (so the choice lives in the URL and works without script).
import type { RouteLocationRaw } from "vue-router";
defineProps<{ label: string; options: Array<{ label: string; to: RouteLocationRaw; active: boolean }> }>();
</script>

<template>
  <div class="seg" role="group" :aria-label="label">
    <NuxtLink v-for="o in options" :key="o.label" :to="o.to" replace class="seg-item" :class="{ 'is-active': o.active }" :aria-current="o.active ? 'true' : undefined">
      {{ o.label }}
    </NuxtLink>
  </div>
</template>
