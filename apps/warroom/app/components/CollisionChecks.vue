<script setup lang="ts">
// The collision checks on a Proposal: DexScreener by name and ticker, GitHub by repo name. A check that could not run says "unknown",
// never "clear"; a Proposal that was never checked (null) says "not checked". Each result shows its source and when it was checked.
// `pills` (list rows) shows just the soft pills with the detail in a tooltip; the default also writes the detail out under each pill.
type Check = { status: "clear" | "collides" | "unknown"; detail: string; source: string; checkedAt: string };
const props = defineProps<{ collisions: { dex: Check; github: Check } | null; pills?: boolean }>();
const LABELS = { clear: "clear", collides: "collides", unknown: "unknown" } as const;
const TONES = { clear: "pill-green", collides: "pill-amber", unknown: "" } as const;
const rows = computed(() =>
  props.collisions
    ? [
        { key: "dex", name: "DexScreener", title: "Name and ticker", check: props.collisions.dex },
        { key: "github", name: "GitHub", title: "Repo name", check: props.collisions.github },
      ]
    : [],
);
const tip = (r: (typeof rows.value)[number]) => `${r.title}: ${r.check.detail} (${r.check.source}, checked ${r.check.checkedAt})`;
</script>

<template>
  <div class="text-sm" data-test="collision-checks">
    <span v-if="!collisions" class="pill" data-test="collision-not-checked">Collision checks: not checked</span>
    <ul v-else-if="pills" class="flex flex-wrap gap-1.5 md:grid">
      <li v-for="r in rows" :key="r.key" :data-test="`collision-${r.key}`" class="justify-self-start">
        <span class="pill" :class="TONES[r.check.status]" :title="tip(r)">{{ r.name }} <span>{{ LABELS[r.check.status] }}</span></span>
      </li>
    </ul>
    <ul v-else class="grid gap-4">
      <li v-for="r in rows" :key="r.key" :data-test="`collision-${r.key}`" class="grid gap-1.5">
        <span class="pill justify-self-start" :class="TONES[r.check.status]">{{ r.name }} <span>{{ LABELS[r.check.status] }}</span></span>
        <span class="muted">{{ r.title }}: {{ r.check.detail }}</span>
        <span class="faint text-xs">{{ r.check.source }}, checked <time :datetime="r.check.checkedAt">{{ r.check.checkedAt }}</time></span>
      </li>
    </ul>
  </div>
</template>
