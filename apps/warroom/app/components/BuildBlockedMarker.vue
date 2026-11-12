<script setup lang="ts">
// A fixed "Build blocked" label beside the status pill; it links to the full BuildNotice further down the page. It never shows the refusal
// message (that holds a path). Template-only on purpose: server/test/build-notice.test.ts renders it.
import type { BuildNoticeView } from "../utils/build-notice.ts";
defineProps<{ view: BuildNoticeView | null }>();
</script>

<template>
  <a v-if="view?.kind === 'refused'" href="#build-notice" class="pill pill-amber" data-test="build-blocked">Build blocked</a>
</template>
