<script setup lang="ts">
// The Research requests and briefs on /research (human researcher ticket 05): one row per topic the Operator typed, newest first, with its status, what
// its runs cost, and, once the worker has made one, the Research brief: the story, its sources, the coins on the topic with market cap and bonded state,
// and names still free. Text only: the topic, the story, the notes and the coin names are untrusted and are shown through {{ }}, cut to a line by
// researchRequestsView. A link is a source address that passed safeHttpUrl, or a coin's DexScreener page. Template-only on purpose (for
// server/test/research-render.test.ts, which renders it): view.
import { safeHttpUrl } from "../utils/safe-link.ts";
import type { ResearchRequestsView } from "../utils/research-brief.ts";

// Under each brief a "Make ideas" button (human researcher ticket 06): it only emits `make` with the research request id; the page posts it. The status
// line and the links are the newest Make ideas request of that brief, as `researchRequestsView` made them (text; a link is a numeric Proposal id only).
defineProps<{ view: ResearchRequestsView; busyId?: number | null }>();
const emit = defineEmits<{ make: [researchRequestId: number] }>();
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
            <p class="text-xs font-semibold">Sources the researcher says it read</p>
            <p class="faint text-xs" data-test="brief-sources-note">Argus has not opened these pages. Read the address beside a link before you click it.</p>
            <ul v-if="r.brief.sources.length > 0" class="grid min-w-0 gap-0.5" data-test="brief-sources">
              <li v-for="(s, i) in r.brief.sources" :key="i" class="min-w-0 break-all text-xs" data-test="brief-source">
                <a v-if="safeHttpUrl(s.href)" :href="safeHttpUrl(s.href) ?? undefined" class="underline" target="_blank" rel="noopener noreferrer nofollow" referrerpolicy="no-referrer">{{ s.title }}</a>
                <template v-else>{{ s.title }}</template>
                <span v-if="s.host" class="muted font-mono" data-test="brief-source-host"> ({{ s.host }})</span>
                <span v-else class="faint" data-test="brief-source-no-link"> (no web link, shown as text)</span>
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
                  <span v-if="c.via" class="faint text-xs" data-test="brief-coin-via">{{ c.via }}</span>
                  <span class="muted text-xs" data-test="brief-coin-facts">{{ c.facts }}</span>
                </div>
                <p v-if="c.note" class="muted min-w-0 break-words text-xs" data-test="brief-coin-note">{{ c.note }}</p>
                <p class="faint min-w-0 break-all text-xs" data-test="brief-coin-ca">
                  <a v-if="safeHttpUrl(c.href)" :href="safeHttpUrl(c.href) ?? undefined" class="underline" target="_blank" rel="noopener noreferrer">{{ c.ca }}</a>
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
          <p v-if="r.brief.termsNote" class="faint min-w-0 break-words text-xs" data-test="brief-terms-note">{{ r.brief.termsNote }}</p>
          <p class="faint min-w-0 break-words text-xs" data-test="brief-x-note">{{ r.brief.xNote }}</p>
        </div>
        <div v-if="r.ideas" class="grid min-w-0 gap-1.5 border-t border-[var(--wr-line)] pt-2" data-test="brief-ideas">
          <div class="flex flex-wrap items-center gap-2">
            <button type="button" class="btn btn-primary min-h-11" :disabled="busyId === r.id || r.ideas.waiting" data-test="brief-make-ideas" @click="emit('make', r.id)">{{ busyId === r.id ? "Sending…" : "Make ideas" }}</button>
            <span class="faint text-xs">Three meme ideas about this topic, from this brief. Runs only when you press it.</span>
          </div>
          <p v-if="r.ideas.status" class="note min-w-0 break-words text-xs" :class="r.ideas.status.tone === 'bad' ? 'note-amber' : r.ideas.status.tone === 'ok' ? 'note-green' : 'muted'" :data-tone="r.ideas.status.tone" data-test="brief-ideas-status">{{ r.ideas.status.text }}</p>
          <ul v-if="r.ideas.links.length > 0" class="flex flex-wrap gap-x-3 gap-y-1 text-xs" data-test="brief-ideas-links">
            <li v-for="l in r.ideas.links" :key="l.href"><NuxtLink :to="l.href" class="link font-medium">{{ l.text }}</NuxtLink></li>
          </ul>
        </div>
      </li>
    </ul>
  </div>
</template>
