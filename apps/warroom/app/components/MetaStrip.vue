<script setup lang="ts">
// The home page's Meta strip: the top Metas of the last 24 h as one row of compact cards (rank, label, momentum, creators and
// migrations after 60 s, top market cap). A card links to its row on /meta. Text only (no raw-HTML directive), clamped by `metaView`;
// the only links are internal ones, drawn by NuxtLink. Template-only on purpose: server/test/meta-render.test.ts renders it.
import type { MetaView } from "../utils/meta.ts";
defineProps<{ view: MetaView }>();
</script>

<template>
  <section class="grid min-w-0 gap-3" data-test="meta-strip" aria-label="Current Meta, last 24 hours">
    <div class="flex items-baseline justify-between gap-3">
      <h3 class="section-title">Current Meta <span class="faint text-xs font-medium">last 24h</span></h3>
      <NuxtLink to="/meta" class="text-sm font-semibold text-[var(--wr-accent-strong)] hover:underline" data-test="meta-all">All Metas →</NuxtLink>
    </div>
    <p v-if="view.state === 'waiting' || view.state === 'none'" class="surface note muted" data-test="meta-note">{{ view.note }}</p>
    <p v-else-if="view.state === 'stale'" class="note note-amber" data-test="meta-stale">{{ view.note }}</p>
    <ol v-if="view.rows.length > 0" class="-mx-1 flex snap-x gap-3 overflow-x-auto px-1 pb-2">
      <li v-for="r in view.rows" :key="r.anchor" class="min-w-[13.5rem] flex-1 snap-start" :data-test="`meta-strip-${r.rank}`">
        <NuxtLink :to="`/meta#${r.anchor}`" class="surface grid h-full content-start gap-1.5 p-4 text-sm transition-shadow hover:shadow-[var(--wr-shadow-lift)]">
          <span class="flex min-w-0 items-center gap-2">
            <span class="pill pill-accent shrink-0 tabular-nums">{{ r.rank }}</span>
            <span class="min-w-0 truncate font-semibold" :title="r.label">{{ r.label }}</span>
          </span>
          <span v-if="r.trend" class="pill pill-outline w-fit" data-test="meta-trend-word">{{ r.trend.word }}</span>
          <span v-if="r.stripLine" class="muted text-xs tabular-nums">{{ r.stripLine }}</span>
          <span v-if="r.topCap" class="faint text-xs tabular-nums">top token {{ r.topCap }}</span>
        </NuxtLink>
      </li>
    </ol>
    <p v-if="view.footer" class="faint text-xs" data-test="meta-footer">{{ view.footer }}</p>
  </section>
</template>
