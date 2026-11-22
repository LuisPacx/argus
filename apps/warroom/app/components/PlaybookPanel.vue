<script setup lang="ts">
// The Playbook on /research (human researcher ticket 09): the latest versions of what tends to bond and what does not, built from the Operator's finished Picks, and
// the "Rebuild playbook" button. The button writes one request row (POST /api/playbook-requests); the worker makes one model run and stores a new version. Nothing
// rebuilds on a timer, and a refusal (fewer than 10 finished Picks, one already waiting) is the server's reason shown as text. It fetches its own data
// (GET /api/playbook, read only) so the page only places it. The lessons were written by a model from Operator-typed reasons: text only, through {{ }}.
// Everything below the script is template-only on purpose (for server/test/playbook-render.test.ts, which renders it): view, busy, error, note, rebuild.
import { playbookView, submitRebuild, type PlaybookPayload } from "../utils/playbook.ts";

const { data, refresh } = await useFetch<PlaybookPayload | null>("/api/playbook", { key: "playbook", default: () => null });
const view = computed(() => playbookView(data.value));
const busy = ref(false);
const error = ref<string | null>(null);
const note = ref<string | null>(null);
async function rebuild() {
  if (busy.value || !view.value.canRebuild) return;
  busy.value = true;
  error.value = null;
  note.value = null;
  const r = await submitRebuild((body) => $fetch<{ id: number; status: string }>("/api/playbook-requests", { method: "POST", body }));
  busy.value = false;
  if (r.ok) note.value = r.note;
  else error.value = r.message;
  await refresh();
}
let timer: ReturnType<typeof setInterval> | undefined;
onMounted(() => {
  timer = setInterval(() => void refresh(), 15_000);
});
onBeforeUnmount(() => clearInterval(timer));
</script>

<template>
  <section class="surface grid min-w-0 gap-3" data-test="playbook">
    <h3 class="section-title">Playbook</h3>
    <p class="note muted">
      What tends to bond and what does not, condensed by one model run from your finished Picks, your reasons and their outcomes. Later research and Make ideas runs read the latest version as hints. It is rebuilt only when you press the button; each rebuild is a new version
      and old versions stay.
    </p>
    <p class="min-w-0 break-words text-sm font-semibold" data-test="playbook-headline">{{ view.headline }}</p>
    <p class="muted min-w-0 break-words text-xs" data-test="playbook-picks">{{ view.picks }}</p>
    <p v-if="view.picksNote" class="muted min-w-0 break-words text-xs" data-test="playbook-picks-note">Pick lessons left out: {{ view.picksNote }}</p>
    <p v-if="view.ideasNote" class="muted min-w-0 break-words text-xs" data-test="playbook-ideas-note">Idea lessons left out: {{ view.ideasNote }}</p>
    <div class="flex min-w-0 flex-wrap items-center gap-2">
      <button type="button" class="btn btn-primary" :disabled="busy || !view.canRebuild" data-test="playbook-rebuild" @click="rebuild">{{ busy ? "Sending…" : "Rebuild playbook" }}</button>
      <p v-if="view.refusal" class="note note-amber min-w-0 flex-1 break-words text-xs" data-test="playbook-refusal">{{ view.refusal }}</p>
    </div>
    <p v-if="error" class="note note-amber min-w-0 break-words text-xs" role="alert" data-test="playbook-error">{{ error }}</p>
    <p v-if="note" class="muted min-w-0 break-words text-xs" role="status" data-test="playbook-note">{{ note }}</p>
    <div v-for="v in view.versions" :key="v.id" class="grid min-w-0 gap-1" data-test="playbook-version">
      <p class="min-w-0 break-words text-xs font-semibold">{{ v.title }}</p>
      <ul class="grid min-w-0 gap-1">
        <li v-for="(l, i) in v.lessons" :key="i" class="min-w-0 break-words text-sm" data-test="playbook-lesson">{{ l }}</li>
      </ul>
      <template v-if="v.ideaLessons.length">
        <p class="min-w-0 break-words text-xs font-semibold" data-test="playbook-ideas-title">Ideas you liked / disliked</p>
        <ul class="grid min-w-0 gap-1">
          <li v-for="(l, i) in v.ideaLessons" :key="i" class="min-w-0 break-words text-sm" data-test="playbook-idea-lesson">{{ l }}</li>
        </ul>
      </template>
    </div>
    <div class="grid min-w-0 gap-1" data-test="playbook-learning">
      <p class="min-w-0 break-words text-xs font-semibold">Is it learning?</p>
      <ul class="grid min-w-0 gap-1">
        <li v-for="(l, i) in view.learning" :key="i" class="min-w-0 break-words text-sm" data-test="playbook-learning-line">{{ l }}</li>
      </ul>
      <p v-if="view.trend" class="min-w-0 break-words text-sm" data-test="playbook-trend">{{ view.trend }}</p>
      <p class="faint min-w-0 break-words text-xs" data-test="playbook-learning-caption">{{ view.caption }}</p>
    </div>
    <p v-for="(r, i) in view.requests" :key="i" class="faint min-w-0 break-words text-xs" data-test="playbook-request">{{ r }}</p>
  </section>
</template>
