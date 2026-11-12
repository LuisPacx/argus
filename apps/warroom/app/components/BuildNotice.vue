<script setup lang="ts">
// Why an approved Proposal's Build has not started (or that it is simply queued). Text only: the refusal message holds a filesystem path,
// so it is drawn with `{{ }}`, never as raw HTML. Template-only on purpose: server/test/build-notice.test.ts renders it.
import type { BuildNoticeView } from "../utils/build-notice.ts";
defineProps<{ view: BuildNoticeView }>();
</script>

<template>
  <p class="surface note" :class="view.kind === 'refused' ? 'note-amber' : 'muted'" :data-test="`build-${view.kind}`">
    <span data-test="build-text">{{ view.text }}</span>
    <span v-if="view.checked" class="faint" data-test="build-checked"> ({{ view.checked }})</span>
  </p>
</template>
