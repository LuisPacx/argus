<script setup lang="ts">
// The Moments list (moment scanner ticket 01): the X session's state with the Resume button (only while it is stopped), then one row per
// rising clip. Text only: every post, handle and text is third-party and is shown as text, cut to one line; the one link per row is built
// by utils/moments.ts only for an https://x.com/<handle>/status/<id> address. The Resume button posts to POST /api/x-session/resume and
// shows what the server said. Template-only names (for server/test/moments-render.test.ts, which renders the template): view, busy, error, resume.
import { resumeFailure, type MomentsView } from "../utils/moments.ts";

defineProps<{ view: MomentsView }>();
const emit = defineEmits<{ resumed: [] }>();
const busy = ref(false);
const error = ref<string | null>(null);

async function resume() {
  busy.value = true;
  error.value = null;
  try {
    await $fetch("/api/x-session/resume", { method: "POST" });
    emit("resumed");
  } catch (e) {
    error.value = resumeFailure(e);
  }
  busy.value = false;
}
</script>

<template>
  <div class="grid min-w-0 gap-6" data-test="moments">
    <section class="surface grid min-w-0 gap-2" data-test="x-session">
      <div class="flex min-w-0 flex-wrap items-center justify-between gap-3">
        <p class="min-w-0 break-words font-semibold" :data-tone="view.session.tone" data-test="x-session-text">{{ view.session.text }}</p>
        <button v-if="view.canResume" type="button" class="btn btn-primary" :disabled="busy" data-test="x-resume" @click="resume">{{ busy ? "Resuming…" : "Resume X jobs" }}</button>
      </div>
      <p v-if="view.session.detail" class="note note-amber min-w-0 break-words text-sm" data-test="x-session-detail">{{ view.session.detail }}</p>
      <p v-if="error" class="note note-amber min-w-0 break-words text-sm" role="alert" data-test="x-resume-error">{{ error }}</p>
      <p class="faint min-w-0 break-words text-xs" data-test="scan-line">{{ view.topic ? `Topic: ${view.topic}. ` : "" }}{{ view.scanLine }}</p>
    </section>

    <p v-if="view.empty" class="surface muted min-w-0 break-words text-sm" data-test="moments-empty">{{ view.empty }}</p>
    <ul v-else class="grid min-w-0 gap-3" data-test="moments-list">
      <li v-for="r in view.rows" :id="`post-${r.key}`" :key="r.key" class="row row-static grid min-w-0 gap-1.5" :data-test="`moment-${r.key}`">
        <div class="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
          <UrlLink v-if="r.href" :href="r.href" :label="`@${r.handle}`" data-test="moment-link" />
          <span v-else class="min-w-0 break-words font-semibold" data-test="moment-handle">@{{ r.handle }}</span>
          <span class="pill pill-accent" data-test="moment-rate">{{ r.perHour }}</span>
          <span v-if="r.recent" class="pill pill-green" data-test="moment-recent">{{ r.recent }}</span>
        </div>
        <p class="min-w-0 break-words text-sm" data-test="moment-text">{{ r.text }}</p>
        <p class="faint min-w-0 break-words text-xs">{{ r.views }} · {{ r.likes }} · {{ r.posted }} · {{ r.readings }}</p>
      </li>
    </ul>
  </div>
</template>
