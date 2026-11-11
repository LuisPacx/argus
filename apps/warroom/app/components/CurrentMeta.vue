<script setup lang="ts">
// "Current Meta (last 24h)": the live Metas, ranked, each with the numbers behind it, a trend word, its top tokens and a one-line summary.
// Everything in `view` is untrusted text (token names are written by token creators, the summary by a model): interpolated as text only
// (no raw-HTML directive), clamped by `metaView`, and a link exists only where `metaView` produced an http(s) href, drawn by UrlLink.
// Template-only on purpose: server/test/current-meta.test.ts renders it.
import type { MetaView } from "../utils/meta.ts";
defineProps<{ view: MetaView; wide?: boolean }>();
</script>

<template>
  <div class="surface grid content-start gap-4" :class="{ 'lg:col-span-2': wide }" data-test="current-meta">
    <h3 class="section-title">Current Meta (last 24h)</h3>
    <p v-if="view.state === 'waiting' || view.state === 'none'" class="note muted" data-test="meta-note">{{ view.note }}</p>
    <p v-else-if="view.state === 'stale'" class="note note-amber" data-test="meta-stale">{{ view.note }}</p>
    <ol v-if="view.rows.length > 0" class="grid gap-3">
      <li v-for="r in view.rows" :key="r.rank" class="inset grid min-w-0 content-start gap-2 px-4 py-3 text-sm" :data-test="`meta-${r.rank}`">
        <div class="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1">
          <span class="pill pill-accent shrink-0 tabular-nums">{{ r.rank }}</span>
          <span class="min-w-0 break-words font-semibold" data-test="meta-label">{{ r.label }}</span>
          <span v-if="r.trend" class="pill pill-outline shrink-0" data-test="meta-trend-word">{{ r.trend.word }}</span>
        </div>
        <p v-if="r.summary" class="muted min-w-0 break-words leading-relaxed" data-test="meta-summary">{{ r.summary }}</p>
        <p v-if="r.numbers.length > 0" class="flex flex-wrap gap-x-3 gap-y-1 text-xs tabular-nums" data-test="meta-numbers">
          <span v-for="(n, i) in r.numbers" :key="i">{{ n }}</span>
        </p>
        <p v-if="r.trend || r.firstSeen" class="faint flex flex-wrap gap-x-3 gap-y-1 text-xs" data-test="meta-trend">
          <span v-if="r.trend">{{ r.trend.text }}</span>
          <span v-if="r.firstSeen">{{ r.firstSeen }}</span>
        </p>
        <ul v-if="r.tokens.length > 0" class="flex min-w-0 flex-wrap gap-x-4 gap-y-1 text-xs" data-test="meta-tokens">
          <li v-for="(t, i) in r.tokens" :key="i" class="min-w-0 max-w-full">
            <UrlLink v-if="t.href" :href="t.href" :label="t.text" />
            <span v-else class="break-words">{{ t.text }}</span>
          </li>
        </ul>
      </li>
    </ol>
    <p v-if="view.footer" class="faint text-xs" data-test="meta-footer">{{ view.footer }}</p>
  </div>
</template>
