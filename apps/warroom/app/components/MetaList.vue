<script setup lang="ts">
// The /meta page's "All launch themes" list (meta redesign ticket 02): every launch theme of the latest run with the numbers behind it, a
// trend word and its top tokens. Counts only: no summary line and no meme ideas (those belong to the Current Meta). These rows are themes,
// not Metas. Everything in `view` is untrusted text (token names are written by token creators): interpolated as text only (no raw-HTML
// directive), clamped by `metaView`, and a link exists only where `metaView` produced an http(s) href, drawn by UrlLink. Each row's id is
// its `anchor`, the fragment Hot now links to. Template-only on purpose: server/test/meta-render.test.ts renders it.
import type { MetaView } from "../utils/meta.ts";
defineProps<{ view: MetaView }>();
</script>

<template>
  <div class="grid gap-4" data-test="meta-list">
    <p v-if="view.state === 'waiting' || view.state === 'none'" class="note muted" data-test="meta-note">{{ view.note }}</p>
    <p v-else-if="view.state === 'stale'" class="note note-amber" data-test="meta-stale">{{ view.note }}</p>
    <p v-if="view.coverageNote" class="muted text-sm" data-test="meta-coverage-note">{{ view.coverageNote }}</p>
    <ol v-if="view.rows.length > 0" class="grid gap-3">
      <li
        v-for="r in view.rows"
        :id="r.anchor"
        :key="r.anchor"
        class="surface grid min-w-0 scroll-mt-6 content-start gap-2 text-sm target:ring-2 target:ring-[var(--wr-accent)]"
        :data-test="`meta-${r.rank}`"
      >
        <div class="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1">
          <span class="pill pill-accent shrink-0 tabular-nums">{{ r.rank }}</span>
          <span class="min-w-0 break-words font-semibold" data-test="meta-label">{{ r.label }}</span>
          <span v-if="r.trend" class="pill pill-outline shrink-0" data-test="meta-trend-word">{{ r.trend.word }}</span>
          <span v-if="r.hot" class="pill pill-accent min-w-0 max-w-full whitespace-normal break-words" data-test="meta-hot">{{ r.hot }}</span>
        </div>
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
  </div>
</template>
