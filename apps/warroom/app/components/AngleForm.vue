<script setup lang="ts">
// "Add an angle" under a Meta or Watching subject on /meta (meta redesign ticket 11): the Operator types an angle, presses one button, and the
// worker files three meme ideas for it. The form only posts `{ metaKey, angle }` to POST /api/meme-angle and shows what the server said; the
// server does every check, and the worker is the only writer of Proposals (CODING_STANDARDS rule 1). The status line under the form is the
// newest request for this subject (GET /api/meme-angle, refreshed by the page on its own poll). Everything shown is text: the draft is a
// textarea value, the status and the server's reason are cut by `angleStatusFor` and `failureReason`. Template-only names (for
// server/test/current-meta-render.test.ts, which renders the template): metaKey, status, draft, counter, canSubmit, busy, error, note, inputId, submit.
import { useId } from "vue";
import { angleCanSubmit, angleCounter, ANGLE_MAX_CHARS, submitAngle, type AngleAccepted, type AngleStatusView } from "../utils/angle.ts";

const props = defineProps<{ metaKey: string; status: AngleStatusView | null }>();
const draft = ref("");
const busy = ref(false);
const error = ref<string | null>(null);
const note = ref<string | null>(null);
const counter = computed(() => angleCounter(draft.value));
const canSubmit = computed(() => angleCanSubmit(draft.value) && !busy.value);
// A unique id per form on the page, so each label points at its own textarea (also the same on the server and the client render).
const inputId = `angle-${useId()}`;

// Escape closes the form (the draft is kept) and puts the focus back on its summary, so the keyboard can open it again with Enter.
const box = ref<HTMLDetailsElement | null>(null);
const summaryEl = ref<HTMLElement | null>(null);
function close() {
  if (box.value) box.value.open = false;
  summaryEl.value?.focus();
}

// `text` null is the "Make ideas" button (human researcher ticket 02): the same POST with no angle in the body.
async function send(text: string | null) {
  busy.value = true;
  error.value = null;
  note.value = null;
  const r = await submitAngle((body) => $fetch<AngleAccepted>("/api/meme-angle", { method: "POST", body }), props.metaKey, text);
  busy.value = false;
  if (r.ok) {
    note.value = r.note;
    if (text !== null) draft.value = "";
    await refreshNuxtData("meme-angle");
  } else error.value = r.message;
}
const submit = () => (canSubmit.value ? send(draft.value) : undefined);
const makeIdeas = () => (busy.value ? undefined : send(null));
</script>

<template>
  <div class="grid min-w-0 gap-1.5 border-t border-[var(--wr-line)] pt-2" data-test="angle-block">
    <div class="flex flex-wrap items-center gap-2">
      <button type="button" class="btn btn-primary min-h-11" :disabled="busy" data-test="make-ideas" @click="makeIdeas">{{ busy ? "Sending…" : "Make ideas" }}</button>
      <span class="faint text-xs">Three meme ideas about this subject, no angle needed.</span>
    </div>
    <details ref="box" class="min-w-0" data-test="angle-form" @keydown.esc="close">
      <summary ref="summaryEl" class="flex min-h-11 cursor-pointer items-center text-xs font-semibold text-[var(--wr-accent-strong)]" data-test="angle-summary">Add an angle</summary>
      <form class="grid min-w-0 gap-2 pb-1" @submit.prevent="submit">
        <label :for="inputId" class="faint text-xs">Your angle on this subject, as text. A link in it is kept as a link; the model never opens it.</label>
        <textarea :id="inputId" v-model="draft" class="field min-w-0 text-sm" rows="4" :maxlength="ANGLE_MAX_CHARS" data-test="angle-input" placeholder="What is the story or the joke?" />
        <div class="flex flex-wrap items-center justify-between gap-2">
          <span class="faint text-xs tabular-nums" data-test="angle-counter">{{ counter }}</span>
          <button type="submit" class="btn btn-primary" :disabled="!canSubmit" data-test="angle-submit">{{ busy ? "Sending…" : "Ask for ideas" }}</button>
        </div>
      </form>
    </details>
    <p v-if="error" class="note note-amber min-w-0 break-words text-xs" role="alert" data-test="angle-error">{{ error }}</p>
    <p v-if="note" class="muted min-w-0 break-words text-xs" data-test="angle-note">{{ note }}</p>
    <p v-if="status" class="note min-w-0 break-words text-xs" :class="status.tone === 'bad' ? 'note-amber' : status.tone === 'ok' ? 'note-green' : 'muted'" :data-tone="status.tone" data-test="angle-status">{{ status.text }}</p>
  </div>
</template>
