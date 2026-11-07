<script setup lang="ts">
// The sort and filter bar above a list (Narratives, Proposals): link pill groups and pill selects, plus a "Clear filters" link.
import type { RouteLocationRaw } from "vue-router";
type Group =
  | { kind: "seg"; key: string; title: string; label: string; options: Array<{ label: string; to: RouteLocationRaw; active: boolean }> }
  | { kind: "select"; key: string; title: string; id: string; value: string; options: Array<{ value: string; label: string }>; class?: string };
defineProps<{ groups: Group[]; filtered: boolean; clearTo: RouteLocationRaw }>();
const emit = defineEmits<{ select: [key: string, value: string] }>();
</script>

<template>
  <div class="flex flex-wrap items-end gap-x-4 gap-y-4">
    <div v-for="g in groups" :key="g.key" class="grid gap-1.5">
      <template v-if="g.kind === 'seg'">
        <span class="eyebrow">{{ g.title }}</span>
        <SegmentedLinks :label="g.label" :options="g.options" />
      </template>
      <template v-else>
        <label class="eyebrow" :for="g.id">{{ g.title }}</label>
        <select :id="g.id" class="select-pill" :class="g.class" :value="g.value" @change="emit('select', g.key, ($event.target as HTMLSelectElement).value)">
          <option v-for="o in g.options" :key="o.value" :value="o.value" :selected="o.value === g.value">{{ o.label }}</option>
        </select>
      </template>
    </div>
    <NuxtLink v-if="filtered" :to="clearTo" replace class="btn btn-ghost">Clear filters</NuxtLink>
  </div>
</template>
