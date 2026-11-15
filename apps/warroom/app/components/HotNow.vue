<script setup lang="ts">
// The home page's Hot now panel: the Metas that just entered the top of the ranking or whose creators doubled in about an hour, each with
// its summary, the matching news (context only, never a trigger), the top tokens and the migrations. Shows nothing when no event is live.
// Everything in `view` is untrusted text (token names by token creators, headlines by third parties, the summary by a model): interpolated
// as text only (no raw-HTML directive), clamped by `hotView`, and a link exists only where `hotView` produced an http(s) href, drawn by
// UrlLink. Template-only on purpose: server/test/hot-render.test.ts renders it.
import type { HotView } from "../utils/hot.ts";
defineProps<{ view: HotView }>();
</script>

<template>
  <section v-if="view.items.length > 0" class="grid min-w-0 gap-3" data-test="hot-now" aria-label="Hot now">
    <div class="flex items-baseline justify-between gap-3">
      <h3 class="section-title">Hot now <span class="faint text-xs font-medium">Metas moving fast</span></h3>
    </div>
    <ul class="grid gap-3">
      <li v-for="(it, n) in view.items" :key="n" class="surface grid min-w-0 content-start gap-2 text-sm" :data-test="`hot-${n + 1}`">
        <div class="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1">
          <span class="pill pill-accent shrink-0">Hot</span>
          <NuxtLink :to="`/meta#${it.anchor}`" class="min-w-0 break-words font-semibold hover:underline" data-test="hot-label">{{ it.label }}</NuxtLink>
          <span v-if="it.reason" class="pill pill-outline min-w-0 max-w-full whitespace-normal break-words" data-test="hot-reason">{{ it.reason }}</span>
          <span v-if="it.raised" class="faint text-xs">{{ it.raised }}</span>
        </div>
        <p v-if="it.summary" class="muted min-w-0 break-words leading-relaxed" data-test="hot-summary">{{ it.summary }}</p>
        <p v-if="it.numbers.length > 0" class="flex flex-wrap gap-x-3 gap-y-1 text-xs tabular-nums" data-test="hot-numbers">
          <span v-for="(t, i) in it.numbers" :key="i">{{ t }}</span>
        </p>
        <ul v-if="it.tokens.length > 0" class="flex min-w-0 flex-wrap gap-x-4 gap-y-1 text-xs" data-test="hot-tokens">
          <li v-for="(t, i) in it.tokens" :key="i" class="min-w-0 max-w-full">
            <UrlLink v-if="t.href" :href="t.href" :label="t.text" />
            <span v-else class="break-words">{{ t.text }}</span>
          </li>
        </ul>
        <div v-if="it.news.length > 0" class="grid gap-1 border-t border-[var(--wr-line)] pt-2" data-test="hot-news">
          <p class="faint text-xs font-medium uppercase tracking-wide">In the news (context)</p>
          <ul class="grid gap-1 text-xs">
            <li v-for="(nw, i) in it.news" :key="i" class="min-w-0 break-words">
              <UrlLink v-if="nw.href" :href="nw.href" :label="nw.title" />
              <span v-else>{{ nw.title }}</span>
              <span v-if="nw.meta" class="faint"> · {{ nw.meta }}</span>
            </li>
          </ul>
        </div>
      </li>
    </ul>
  </section>
</template>
