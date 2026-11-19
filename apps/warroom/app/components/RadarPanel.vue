<script setup lang="ts">
// The Radar list (trend radar ticket 01): the banners for a source that has been down for over an hour, one row per Trend (the term, its Google
// traffic, how old it is, the coin-side state with the biggest live token and the lookalikes with their reasons, the local creates, the news
// headline), the Trends that already have a coin folded below, and one status line per source. Text only: every term, headline, token name and
// reason is third-party and is shown as text, cut to a line. The only links are the news link and the token's DexScreener page, both through
// safeHttpUrl in utils/radar.ts. Template-only on purpose (for server/test/radar-render.test.ts, which renders it): view.
import type { RadarPageView } from "../utils/radar.ts";

defineProps<{ view: RadarPageView }>();
</script>

<template>
  <div class="grid min-w-0 gap-6" data-test="radar">
    <div v-if="view.alerts.length > 0" class="grid min-w-0 gap-2" data-test="radar-alerts">
      <p v-for="a in view.alerts" :key="a" class="note note-amber min-w-0 break-words text-sm" role="status" data-test="radar-alert">{{ a }}</p>
    </div>

    <p v-if="view.empty" class="surface muted min-w-0 break-words text-sm" data-test="radar-empty">{{ view.empty }}</p>
    <p v-else-if="view.summary" class="faint min-w-0 break-words text-xs" data-test="radar-summary">{{ view.summary }}</p>

    <template v-for="g in view.groups" :key="g.key">
      <component :is="g.title ? 'details' : 'div'" class="min-w-0" :data-test="`radar-${g.key}`">
        <summary v-if="g.title" class="faint cursor-pointer select-none text-sm font-medium" data-test="radar-folded-title">{{ g.title }}</summary>
        <ul class="mt-3 grid min-w-0 gap-3 first:mt-0">
          <li v-for="r in g.rows" :id="`trend-${r.key}`" :key="r.key" class="row row-static grid min-w-0 gap-1.5" :data-test="`trend-${r.key}`">
            <div class="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
              <span class="min-w-0 break-words font-semibold" data-test="trend-term">{{ r.term }}</span>
              <span class="pill" :class="{ 'pill-green': r.tone === 'green', 'pill-amber': r.tone === 'amber', 'pill-red': r.tone === 'red', 'pill-outline': r.tone === 'muted' }" :data-side="r.side" data-test="trend-side">{{ r.sideLabel }}</span>
              <span class="faint text-xs" data-test="trend-traffic">{{ r.traffic }}</span>
              <span class="faint text-xs" data-test="trend-seen">{{ r.seen }}</span>
            </div>
            <p class="min-w-0 break-words text-sm" data-test="trend-coin">
              <UrlLink v-if="r.tokenHref" :href="r.tokenHref" :label="r.coinLine" data-test="trend-token-link" />
              <template v-else>{{ r.coinLine }}</template>
              <span v-if="r.coinNote" class="faint" data-test="trend-coin-note"> {{ r.coinNote }}</span>
            </p>
            <ul v-if="r.lookalikes.length > 0" class="muted grid min-w-0 gap-0.5 text-xs" data-test="trend-lookalikes">
              <li v-for="l in r.lookalikes" :key="l.key" class="min-w-0 break-words">Lookalike, not counted: {{ l.text }}</li>
              <li v-if="r.lookalikesMore" class="faint">{{ r.lookalikesMore }}</li>
            </ul>
            <p class="faint min-w-0 break-words text-xs" data-test="trend-creates">{{ r.createsLine }} {{ r.checked }}.</p>
            <p v-if="r.news" class="min-w-0 break-words text-xs" data-test="trend-news">
              <UrlLink v-if="r.news.href" :href="r.news.href" :label="r.news.title" data-test="trend-news-link" />
              <template v-else>{{ r.news.title }}</template>
            </p>
          </li>
        </ul>
      </component>
    </template>

    <section class="surface grid min-w-0 gap-2" data-test="radar-sources" aria-label="Sources">
      <h3 class="section-title">Sources</h3>
      <p v-if="view.sources.length === 0" class="faint text-xs" data-test="radar-no-sources">No source has been polled yet.</p>
      <ul v-else class="grid min-w-0 gap-1 text-sm">
        <li v-for="s in view.sources" :key="s.key" class="min-w-0 break-words" :data-test="`source-${s.key}`" :data-tone="s.tone">
          <span class="font-medium">{{ s.label }}:</span> {{ s.text }}
        </li>
      </ul>
      <p class="faint text-xs">Data source: Google Trends. Last good poll of any source: {{ view.lastGood }}.</p>
    </section>
  </div>
</template>
