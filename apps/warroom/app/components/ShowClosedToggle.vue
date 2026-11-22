<script setup lang="ts">
// The link that shows or hides closed and dismissed Proposals in a list (War Room ticket 20). `to` is the page with the choice flipped.
defineProps<{ count: number; showing: boolean; to: string | Record<string, unknown> }>();
</script>

<template>
  <NuxtLink :to="to" replace class="btn btn-ghost justify-self-start" data-test="show-closed" :aria-pressed="showing ? 'true' : 'false'">{{ showing ? "Hide" : "Show" }} closed and dismissed ({{ count }})</NuxtLink>
</template>
