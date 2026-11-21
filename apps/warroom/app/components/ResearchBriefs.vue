<script setup lang="ts">
// The Research requests and briefs on /research (human researcher ticket 05): one row per topic the Operator typed, newest first, with its status, what
// its runs cost, and, once the worker has made one, the Research brief: the story, its sources, the coins on the topic with market cap and bonded state,
// and names still free. Text only: the topic, the story, the notes and the coin names are untrusted and are shown through {{ }}, cut to a line by
// researchRequestsView. A link is a source address that passed safeHttpUrl, or a coin's DexScreener page. Template-only on purpose (for
// server/test/research-render.test.ts, which renders it): view.
import type { ResearchRequestsView } from "../utils/research-brief.ts";

defineProps<{ view: ResearchRequestsView }>();
</script>

<template>
  <div class="grid min-w-0 gap-3" data-test="briefs">
    <p v-if="view.empty" class="surface muted min-w-0 break-words text-sm" data-test="briefs-empty">{{ view.empty }}</p>
    <ul class="grid min-w-0 gap-3">
      <li v-for="r in view.rows" :id="`research-${r.id}`" :key="r.id" class="row row-static grid min-w-0 gap-2" :data-test="`research-${r.id}`">
        <div class="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
          <span class="min-w-0 break-words font-semibold" data-test="research-topic">{{ r.topic }}</span>
          <span class="pill" :class="r.statusClass" data-test="research-status">{{ r.status }}</span>
          <span class="faint text-xs" data-test="research-asked">{{ r.asked }}</span>
          <span class="faint text-xs" data-test="research-cost">{{ r.cost }}</span>
        </div>
        <p v-if="r.detail" class="muted min-w-0 break-words text-xs" data-test="research-detail">{{ r.detail }}</p>
        <div v-if="r.brief" class="grid min-w-0 gap-2" data-test="brief">
          <p class="min-w-0 break-words text-sm" data-test="brief-story">{{ r.brief.story }}</p>
          <div class="grid min-w-0 gap-1">
            <p class="text-xs font-semibold">Sources</p>
            <ul v-if="r.brief.sources.length > 0" class="grid min-w-0 gap-0.5" data-test="brief-sources">
              <li v-for="(s, i) in r.brief.sources" :key="i" class="min-w-0 break-all text-xs" data-test="brief-source">
                <a v-if="s.href" :href="s.href" class="underline" target="_blank" rel="noopener noreferrer nofollow">{{ s.title }}</a>
                <template v-else>{{ s.title }}</template>
              </li>
            </ul>
            <p v-else class="faint text-xs" data-test="brief-no-sources">The model named no source.</p>
          </div>
          <div class="grid min-w-0 gap-1">
            <p class="text-xs font-semibold">Coins on the topic</p>
            <ul v-if="r.brief.coins.length > 0" class="grid min-w-0 gap-1.5" data-test="brief-coins">
              <li v-for="(c, i) in r.brief.coins" :key="i" class="grid min-w-0 gap-0.5" data-test="brief-coin">
                <div class="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
                  <span class="min-w-0 break-words text-sm font-medium" data-test="brief-coin-title">{{ c.title }}</span>
                  <span class="pill" :class="c.bondedClass" data-test="brief-coin-bonded">{{ c.bonded }}</span>
                  <span class="muted text-xs" data-test="brief-coin-facts">{{ c.facts }}</span>
                </div>
                <p v-if="c.note" class="muted min-w-0 break-words text-xs" data-test="brief-coin-note">{{ c.note }}</p>
                <p class="faint min-w-0 break-all text-xs" data-test="brief-coin-ca">
                  <a v-if="c.href" :href="c.href" class="underline" target="_blank" rel="noopener noreferrer">{{ c.ca }}</a>
                  <template v-else>{{ c.ca }}</template>
                </p>
              </li>
            </ul>
            <p v-else class="faint text-xs" data-test="brief-no-coins">{{ r.brief.noCoins }}</p>
          </div>
          <div class="grid min-w-0 gap-1">
            <p class="text-xs font-semibold">Names still free</p>
            <ul v-if="r.brief.freeNames.length > 0" class="grid min-w-0 gap-0.5" data-test="brief-free-names">
              <li v-for="(n, i) in r.brief.freeNames" :key="i" class="min-w-0 break-words text-xs" data-test="brief-free-name">
                <span class="font-medium">{{ n.label }}</span>: {{ n.why }}<span v-if="n.note" class="muted"> ({{ n.note }})</span>
              </li>
            </ul>
            <p v-else class="faint text-xs" data-test="brief-no-free-names">{{ r.brief.noFreeNames }}</p>
          </div>
          <p class="faint min-w-0 break-words text-xs" data-test="brief-x-note">{{ r.brief.xNote }}</p>
        </div>
      </li>
    </ul>
  </div>
</template>
