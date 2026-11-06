<script setup lang="ts">
// The collision checks on a Proposal: DexScreener by name and ticker, GitHub by repo name. A check that could not run says "unknown",
// never "clear"; a Proposal that was never checked (null) says "not checked". Each result shows its source and when it was checked.
type Check = { status: "clear" | "collides" | "unknown"; detail: string; source: string; checkedAt: string };
const props = defineProps<{ collisions: { dex: Check; github: Check } | null }>();
const LABELS = { clear: "clear", collides: "collides", unknown: "unknown" } as const;
const COLORS = { clear: "text-green-600", collides: "text-red-500", unknown: "text-amber-500" } as const;
const rows = computed(() =>
  props.collisions
    ? [
        { key: "dex", title: "Name and ticker", check: props.collisions.dex },
        { key: "github", title: "Repo name", check: props.collisions.github },
      ]
    : [],
);
</script>

<template>
  <div class="text-sm" data-test="collision-checks">
    <p v-if="!collisions" class="text-muted" data-test="collision-not-checked">Collision checks: not checked</p>
    <ul v-else class="grid gap-1">
      <li v-for="r in rows" :key="r.key" :data-test="`collision-${r.key}`">
        <strong>{{ r.title }}:</strong>
        <span :class="COLORS[r.check.status]" class="font-semibold">{{ LABELS[r.check.status] }}</span>
        <span class="text-muted"> {{ r.check.detail }} ({{ r.check.source }}, checked <time :datetime="r.check.checkedAt">{{ r.check.checkedAt }}</time>)</span>
      </li>
    </ul>
  </div>
</template>
