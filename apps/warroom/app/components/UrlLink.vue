<script setup lang="ts">
// An external link whose text truncates with an ellipsis while the full URL stays in the title tooltip.
defineProps<{ href: string; label?: string }>();
</script>

<template>
  <a class="url-link" :href="href" :title="href" target="_blank" rel="noopener noreferrer">
    <span>{{ label ?? bareUrl(href) }}</span>
    <svg class="size-3.5 shrink-0 opacity-70" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M9 2.5h4.5V7M13.5 2.5 7.5 8.5M12 9.5v3a1 1 0 0 1-1 1H3.5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h3" />
    </svg>
  </a>
</template>
