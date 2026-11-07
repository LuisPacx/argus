<script setup lang="ts">
// A Proposal's lifecycle status as a soft pill. The tone is presentation only; the text is the status itself.
const props = defineProps<{ status: string }>();
const TONES: Record<string, string> = {
  new: "",
  shortlisted: "pill-accent",
  "spec-drafted": "pill-green",
  approved: "pill-green",
  building: "pill-amber",
  built: "pill-green",
  launched: "pill-green",
  "build-failed": "pill-red",
  "needs-human": "pill-red",
  closed: "",
  dismissed: "",
};
const tone = computed(() => TONES[props.status] ?? "");
</script>

<template>
  <span class="pill" :class="tone" data-test="status">{{ status }}</span>
</template>
