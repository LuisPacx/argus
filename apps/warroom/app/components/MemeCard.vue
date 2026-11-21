<script setup lang="ts">
// The body of a meme Proposal's page (ADR 0013): the idea (angle, how it differs, the short description, the X first post, the image idea as
// text, the risk labels), the Meta as it was when the idea was made (from the stored snapshot, so it stays readable after the Meta moves),
// and why it was made with its evidence links. A meme has no Tech, no Spec and no Score of its own, so none of those is drawn here. An idea
// made from a news story (proposal-routing ticket 04) shows the story where the Meta would be, a "from news" block with a link to its
// Narrative and the Score that failed the buildability gate.
// Everything in `view` is untrusted text (the idea is model-written, the tokens' names creator-written, the headlines third-party):
// interpolated as text only (no raw-HTML directive), clamped by `memeView`, and a link exists only where `memeView` produced an http(s)
// href, drawn by UrlLink. Template-only on purpose: server/test/meme-render.test.ts renders it.
import type { MemeView } from "../utils/meme.ts";
defineProps<{ view: MemeView }>();
</script>

<template>
  <div class="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-5" data-test="meme-card">
    <section v-if="view.operatorAngle && view.operatorAngle.kind !== 'topic'" class="surface rise" style="--i: 0" data-test="meme-operator-angle">
      <h3 class="section-title">{{ view.operatorAngle.kind === "button" ? "Make ideas" : "Operator angle" }}</h3>
      <div class="mt-4 grid min-w-0 gap-2 text-sm">
        <p v-if="view.operatorAngle.kind === 'button'" class="faint text-xs" data-test="meme-operator-angle-intro">You pressed Make ideas on the Meta page; no angle was typed. The ideas below are about the Meta.</p>
        <p v-else class="faint text-xs" data-test="meme-operator-angle-intro">The angle you typed on the Meta page. The ideas below are about it.</p>
        <p v-if="view.operatorAngle.kind === 'typed'" class="min-w-0 break-words font-semibold leading-relaxed" data-test="meme-operator-angle-text">{{ view.operatorAngle.text }}</p>
        <p v-if="view.operatorAngle.sourceText" class="min-w-0 break-words text-xs" data-test="meme-operator-angle-source">
          Source:
          <UrlLink v-if="view.operatorAngle.href" :href="view.operatorAngle.href" :label="view.operatorAngle.sourceText" />
          <span v-else>{{ view.operatorAngle.sourceText }}</span>
        </p>
        <p v-else-if="view.operatorAngle.dropped" class="faint text-xs" data-test="meme-operator-angle-dropped">The link in the text was dropped: it was not a plain http or https address.</p>
      </div>
    </section>

    <section v-if="view.fromTopic" class="surface rise" style="--i: 0" data-test="meme-from-topic">
      <h3 class="section-title">From a topic</h3>
      <div class="mt-4 grid min-w-0 gap-2 text-sm">
        <p class="faint text-xs">You pressed Make ideas under the Research brief on this topic. The ideas below are about it.</p>
        <p class="min-w-0 break-words font-semibold" data-test="meme-from-topic-topic">From topic: {{ view.fromTopic.topic }}</p>
        <p class="text-xs" data-test="meme-from-topic-link">
          <NuxtLink v-if="view.fromTopic.href" :to="view.fromTopic.href" class="link font-medium">{{ view.fromTopic.linkText }}</NuxtLink>
          <span v-else class="faint">{{ view.fromTopic.linkText }}</span>
        </p>
      </div>
    </section>

    <section v-if="view.fromNews" class="surface rise" style="--i: 0" data-test="meme-from-news">
      <h3 class="section-title">From news</h3>
      <div class="mt-4 grid min-w-0 gap-2 text-sm">
        <p class="min-w-0 break-words font-semibold" data-test="meme-from-news-headline">From news: {{ view.fromNews.headline }}</p>
        <p class="text-xs" data-test="meme-from-news-link">
          <NuxtLink v-if="view.fromNews.href" :to="view.fromNews.href" class="link font-medium">{{ view.fromNews.linkText }}</NuxtLink>
          <span v-else class="faint">{{ view.fromNews.linkText }}</span>
        </p>
        <p v-if="view.fromNews.score" class="min-w-0 break-words text-xs tabular-nums" data-test="meme-from-news-score">{{ view.fromNews.score }}</p>
        <p v-if="view.fromNews.reasons" class="muted min-w-0 break-words text-xs leading-relaxed" data-test="meme-from-news-reasons">The judge's reasons: {{ view.fromNews.reasons }}</p>
      </div>
    </section>

    <section class="surface rise" style="--i: 1" data-test="meme-idea">
      <h3 class="section-title">The idea</h3>
      <div class="mt-4 grid min-w-0 grid-cols-[minmax(0,1fr)] gap-5">
        <div data-test="meme-angle">
          <p class="eyebrow mb-1.5">Angle: the joke and why now</p>
          <p class="min-w-0 break-words leading-relaxed">{{ view.angle }}</p>
        </div>
        <div v-if="view.difference" data-test="meme-difference">
          <p class="eyebrow mb-1.5">{{ view.source === "news" ? "How it differs from the tokens already riding the story" : view.source === "topic" ? "How it differs from the coins already on the topic" : "How it differs from the leader" }}</p>
          <p class="min-w-0 break-words leading-relaxed">{{ view.difference }}</p>
        </div>
        <div v-if="view.description" data-test="meme-description">
          <p class="eyebrow mb-1.5">Description</p>
          <p class="min-w-0 break-words leading-relaxed">{{ view.description }}</p>
        </div>
        <div v-if="view.hook" data-test="meme-hook">
          <p class="eyebrow mb-1.5">First post on X</p>
          <p class="inset min-w-0 break-words px-4 py-3 leading-relaxed">{{ view.hook }}</p>
        </div>
        <div v-if="view.imageIdea" data-test="meme-image">
          <p class="eyebrow mb-1.5">Image idea (text only: argus makes no image)</p>
          <p class="min-w-0 break-words leading-relaxed">{{ view.imageIdea }}</p>
        </div>
        <div v-if="view.copyNote" data-test="meme-copy-note">
          <p class="eyebrow mb-1.5">Name check</p>
          <p class="min-w-0 break-words text-sm leading-relaxed">{{ view.copyNote }}</p>
        </div>
        <div data-test="meme-risk">
          <p class="eyebrow mb-1.5">Risk labels</p>
          <ul v-if="view.riskLabels.length > 0" class="flex flex-wrap gap-2">
            <li v-for="(l, i) in view.riskLabels" :key="i" class="pill pill-amber min-w-0 max-w-full whitespace-normal break-words" data-test="meme-risk-label">{{ l }}</li>
          </ul>
          <p v-else class="faint text-sm" data-test="absent">None named.</p>
        </div>
      </div>
    </section>

    <section class="surface rise" style="--i: 2" data-test="meme-meta">
      <h3 class="section-title">{{ view.source === "news" ? "The story when the idea was made" : view.source === "topic" ? "The Research brief when the idea was made" : "The Meta when the idea was made" }}</h3>
      <div class="mt-4 grid min-w-0 gap-2 text-sm">
        <p v-if="view.meta.label" class="min-w-0 break-words font-semibold" data-test="meme-meta-label">{{ view.meta.label }}</p>
        <p v-if="view.meta.summary" class="muted min-w-0 break-words leading-relaxed" data-test="meme-meta-summary">{{ view.meta.summary }}</p>
        <p v-if="view.meta.numbers.length > 0" class="flex flex-wrap gap-x-3 gap-y-1 text-xs tabular-nums" data-test="meme-meta-numbers">
          <span v-for="(n, i) in view.meta.numbers" :key="i">{{ n }}</span>
        </p>
        <p v-if="view.meta.trigger || view.meta.ranking" class="faint flex flex-wrap gap-x-3 gap-y-1 text-xs" data-test="meme-meta-trigger">
          <span v-if="view.meta.trigger">{{ view.meta.trigger }}</span>
          <span v-if="view.meta.ranking">{{ view.meta.ranking }}</span>
        </p>
        <p v-if="view.meta.roomLeft" class="muted text-xs leading-relaxed" data-test="meme-meta-room">Room left: {{ view.meta.roomLeft }}</p>
        <ul v-if="view.meta.tokens.length > 0" class="flex min-w-0 flex-wrap gap-x-4 gap-y-1 text-xs" data-test="meme-meta-tokens">
          <li v-for="(t, i) in view.meta.tokens" :key="i" class="min-w-0 max-w-full">
            <UrlLink v-if="t.href" :href="t.href" :label="t.text" />
            <span v-else class="break-words">{{ t.text }}</span>
          </li>
        </ul>
      </div>
    </section>

    <section class="surface rise" style="--i: 3" data-test="meme-why">
      <h3 class="section-title">Why this idea</h3>
      <div class="mt-4 grid min-w-0 grid-cols-[minmax(0,1fr)] gap-5">
        <div class="min-w-0" data-test="meme-reason">
          <p class="eyebrow mb-1.5">Trigger</p>
          <p v-if="view.reason" class="min-w-0 break-words leading-relaxed">{{ view.reason }}</p>
          <p v-else class="faint text-sm" data-test="absent">Not recorded for this idea.</p>
        </div>
        <div data-test="meme-news">
          <p class="eyebrow mb-1.5">In the news (context, not evidence of demand)</p>
          <ul v-if="view.news.length > 0" class="grid gap-2">
            <li v-for="(n, i) in view.news" :key="i" class="inset min-w-0 break-words px-4 py-3 text-sm">
              <UrlLink v-if="n.href" :href="n.href" :label="n.title" />
              <span v-else>{{ n.title }}</span>
              <span v-if="n.meta" class="faint"> · {{ n.meta }}</span>
            </li>
          </ul>
          <p v-else class="faint text-sm" data-test="absent">No matching headline was stored.</p>
        </div>
        <div data-test="meme-evidence">
          <p class="eyebrow mb-1.5">Evidence links</p>
          <ul v-if="view.evidence.length > 0" class="grid gap-2">
            <li v-for="(e, i) in view.evidence" :key="i" class="inset flex min-w-0 items-center px-4 py-3 text-sm">
              <UrlLink v-if="e.href" :href="e.href" :label="e.text" />
              <span v-else class="min-w-0 truncate">{{ e.text }}</span>
            </li>
          </ul>
          <p v-else class="faint text-sm" data-test="absent">No evidence links.</p>
        </div>
      </div>
    </section>
  </div>
</template>
