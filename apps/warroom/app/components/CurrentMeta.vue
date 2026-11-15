<script setup lang="ts">
// The Current Meta (meta redesign ticket 02, ADR 0014): at most 3 Metas, each led by a token at millions of market cap, then "Watching"
// (subjects that are up but are not a Meta). With no Meta the note "No Meta right now" stays and Watching still shows. Used on the home
// page (`home`: links to /meta) and on /meta. Everything in `view` is untrusted text (token names by token creators, summaries and ideas by
// a model): interpolated as text only (no raw-HTML directive), clamped by `currentMetaView`, and a link exists only where it produced an
// http(s) href, drawn by UrlLink; the only other links are internal ones, drawn by NuxtLink. Template-only on purpose:
// server/test/current-meta-render.test.ts renders it.
import type { CurrentMetaView } from "../utils/meta.ts";
defineProps<{ view: CurrentMetaView; home?: boolean }>();
</script>

<template>
  <section class="grid min-w-0 gap-4" data-test="current-meta" aria-label="Current Meta">
    <div class="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
      <h3 class="section-title">Current Meta</h3>
      <span v-if="home" class="flex flex-wrap gap-x-4 gap-y-1 text-sm font-semibold">
        <NuxtLink to="/meta" class="text-[var(--wr-accent-strong)] hover:underline" data-test="meta-all">Meta page →</NuxtLink>
        <NuxtLink to="/meta#all-launch-themes" class="text-[var(--wr-accent-strong)] hover:underline" data-test="meta-themes-link">All launch themes</NuxtLink>
      </span>
    </div>
    <p v-if="view.state === 'waiting'" class="surface note muted" data-test="meta-note">{{ view.note }}</p>
    <p v-else-if="view.state === 'stale'" class="note note-amber" data-test="meta-stale">{{ view.note }}</p>
    <p v-if="view.coverageNote" class="faint text-xs" data-test="meta-coverage-note">{{ view.coverageNote }}</p>
    <p v-if="view.emptyNote" class="surface note" data-test="meta-empty"><strong>{{ view.emptyNote }}</strong></p>

    <ol v-if="view.metas.length > 0" class="grid gap-3 md:grid-cols-3" data-test="metas">
      <li v-for="(m, n) in view.metas" :key="n" class="surface grid min-w-0 content-start gap-2 text-sm" :data-test="`current-meta-${n + 1}`">
        <div class="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1">
          <span class="pill pill-accent shrink-0">Meta</span>
          <span class="min-w-0 break-words font-semibold" data-test="current-label">{{ m.label }}</span>
          <span v-if="m.cooling" class="pill pill-amber shrink-0" :title="m.coolingWhy ?? undefined" data-test="current-cooling">cooling</span>
          <span v-if="m.newMeta" class="pill pill-outline min-w-0 max-w-full whitespace-normal break-words" data-test="current-new-meta">{{ m.newMeta }}</span>
        </div>
        <p class="min-w-0 break-words text-xs" data-test="current-leader">
          <UrlLink v-if="m.leaderHref" :href="m.leaderHref" :label="m.leader" />
          <span v-else class="font-medium">{{ m.leader }}</span>
          <span class="tabular-nums"> {{ m.cap }}</span>
          <span v-if="m.capNote" class="faint" data-test="current-cap-note"> ({{ m.capNote }})</span>
        </p>
        <p v-if="m.cooling" class="faint text-xs" data-test="current-cooling-why">{{ m.coolingWhy }}</p>
        <p v-if="m.summary" class="muted min-w-0 break-words leading-relaxed" data-test="current-summary">{{ m.summary }}</p>
        <p class="faint flex flex-wrap gap-x-3 gap-y-1 text-xs tabular-nums" data-test="current-copies">
          <span>{{ m.copies }}</span>
          <span v-if="m.since">{{ m.since }}</span>
        </p>
        <ul v-if="m.tokens.length > 0" class="flex min-w-0 flex-wrap gap-x-4 gap-y-1 text-xs" data-test="current-tokens">
          <li v-for="(t, i) in m.tokens" :key="i" class="min-w-0 max-w-full">
            <UrlLink v-if="t.href" :href="t.href" :label="t.text" />
            <span v-else class="break-words">{{ t.text }}</span>
          </li>
        </ul>
        <div v-if="m.ideas && m.ideas.length > 0" class="grid gap-2 border-t border-[var(--wr-line)] pt-2" data-test="meta-ideas">
          <p class="faint text-xs font-medium uppercase tracking-wide">Meme ideas</p>
          <ul class="grid gap-2">
            <li v-for="i in m.ideas" :key="i.id" class="grid min-w-0 gap-1" :data-test="`meta-idea-${i.id}`">
              <div class="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                <span class="pill pill-outline shrink-0" data-test="idea-kind">meme</span>
                <NuxtLink :to="i.href" class="min-w-0 break-words font-semibold hover:underline" data-test="idea-name">{{ i.name }}</NuxtLink>
                <span class="faint text-xs font-medium uppercase tracking-wide">{{ i.ticker }}</span>
                <span class="pill shrink-0" :class="i.status === 'shortlisted' ? 'pill-accent' : ''" data-test="idea-status">{{ i.status }}</span>
                <span v-for="(l, k) in i.riskLabels" :key="k" class="pill pill-amber min-w-0 max-w-full whitespace-normal break-words" data-test="idea-risk">{{ l }}</span>
                <span v-if="i.expires" class="faint text-xs" data-test="idea-expires">{{ i.expires }}</span>
              </div>
              <p v-if="i.angle" class="muted min-w-0 break-words text-xs leading-relaxed" data-test="idea-angle">{{ i.angle }}</p>
            </li>
          </ul>
        </div>
      </li>
    </ol>

    <div v-if="view.watching.length > 0" class="grid gap-2" data-test="watching">
      <h4 class="text-sm font-semibold">Watching <span class="faint text-xs font-medium">not a Meta</span></h4>
      <p class="faint text-xs" data-test="watching-note">Not a Meta: a token is up but has not reached the entry market cap.</p>
      <ul class="grid gap-2 md:grid-cols-3">
        <li v-for="(w, n) in view.watching" :key="n" class="surface grid min-w-0 content-start gap-1.5 text-sm" :data-test="`watching-${n + 1}`">
          <div class="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1">
            <span class="pill pill-outline shrink-0" data-test="watching-pill">Watching, not a Meta</span>
            <span class="min-w-0 break-words font-semibold" data-test="current-label">{{ w.label }}</span>
          </div>
          <p class="min-w-0 break-words text-xs" data-test="current-leader">
            <UrlLink v-if="w.leaderHref" :href="w.leaderHref" :label="w.leader" />
            <span v-else class="font-medium">{{ w.leader }}</span>
            <span class="tabular-nums"> {{ w.cap }}</span>
            <span v-if="w.capNote" class="faint" data-test="current-cap-note"> ({{ w.capNote }})</span>
          </p>
          <p v-if="w.summary" class="muted min-w-0 break-words text-xs leading-relaxed" data-test="current-summary">{{ w.summary }}</p>
          <p class="faint flex flex-wrap gap-x-3 gap-y-1 text-xs tabular-nums" data-test="current-copies">
            <span>{{ w.copies }}</span>
            <span v-if="w.since">{{ w.since }}</span>
          </p>
        </li>
      </ul>
    </div>
    <p v-if="view.footer" class="faint text-xs" data-test="meta-footer">{{ view.footer }}</p>
  </section>
</template>
