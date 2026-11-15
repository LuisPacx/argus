<script setup lang="ts">
// The New Meta alert (home and /meta): the subjects that just became a Meta, each with its leader token and market cap, its summary, the
// matching news (context only, never a trigger), the top tokens and the migrations. Shows nothing when no event is live. Everything in
// `view` is untrusted text (token names by token creators, headlines by third parties, the summary by a model): interpolated as text only
// (no raw-HTML directive), clamped by `newMetaView`, and a link exists only where `newMetaView` produced an http(s) href, drawn by UrlLink.
// Template-only on purpose: server/test/new-meta-render.test.ts renders it.
import type { NewMetaView } from "../utils/new-meta.ts";
defineProps<{ view: NewMetaView }>();
</script>

<template>
  <section v-if="view.items.length > 0" class="grid min-w-0 gap-3" data-test="new-meta" aria-label="New Meta">
    <div class="flex items-baseline justify-between gap-3">
      <h3 class="section-title">New Meta <span class="faint text-xs font-medium">just became a Meta</span></h3>
    </div>
    <ul class="grid gap-3">
      <li v-for="(it, n) in view.items" :key="n" class="surface grid min-w-0 content-start gap-2 text-sm" :data-test="`new-meta-${n + 1}`">
        <div class="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1">
          <span class="pill pill-accent shrink-0">New</span>
          <NuxtLink :to="`/meta#${it.anchor}`" class="min-w-0 break-words font-semibold hover:underline" data-test="new-meta-label">{{ it.label }}</NuxtLink>
          <span v-if="it.reason" class="pill pill-outline min-w-0 max-w-full whitespace-normal break-words" data-test="new-meta-reason">{{ it.reason }}</span>
          <span v-if="it.raised" class="faint text-xs">{{ it.raised }}</span>
        </div>
        <p v-if="it.summary" class="muted min-w-0 break-words leading-relaxed" data-test="new-meta-summary">{{ it.summary }}</p>
        <p v-if="it.leader" class="min-w-0 break-words text-xs" data-test="new-meta-leader">
          <span class="faint">Leader </span>
          <UrlLink v-if="it.leader.href" :href="it.leader.href" :label="it.leader.text" />
          <span v-else>{{ it.leader.text }}</span>
        </p>
        <p v-if="it.numbers.length > 0" class="flex flex-wrap gap-x-3 gap-y-1 text-xs tabular-nums" data-test="new-meta-numbers">
          <span v-for="(t, i) in it.numbers" :key="i">{{ t }}</span>
        </p>
        <ul v-if="it.tokens.length > 0" class="flex min-w-0 flex-wrap gap-x-4 gap-y-1 text-xs" data-test="new-meta-tokens">
          <li v-for="(t, i) in it.tokens" :key="i" class="min-w-0 max-w-full">
            <UrlLink v-if="t.href" :href="t.href" :label="t.text" />
            <span v-else class="break-words">{{ t.text }}</span>
          </li>
        </ul>
        <div v-if="it.news.length > 0" class="grid gap-1 border-t border-[var(--wr-line)] pt-2" data-test="new-meta-news">
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
