<script setup lang="ts">
// The Operator's Idea verdict on a meme Proposal (War Room ticket 21), on /proposals/<id>: Good and Bad post at once (no tags), and "Add why" (reason
// tags and a note of at most 500 characters) posts a superseding row for the current verdict. The history is kept; the newest row is current. Posts
// to POST /api/proposals/<id>/verdict and shows what the server said; the server does every check, and the kind and Playbook version are read
// there, never sent. Everything shown is text (the note is a textarea value and a clamped line). Template-only names (for
// server/test/idea-verdict-render.test.ts, which renders the template): view, busy, error, inputId, click, toggleTag, saveWhy, close, box, summaryEl.
import { useId } from "vue";
import { ideaVerdictView, oneClickBody, whyBody, type IdeaVerdictPayload } from "../utils/idea-verdict.ts";
import { submitVerdict } from "../utils/verdict.ts";

const props = defineProps<{ proposalId: number; history: IdeaVerdictPayload[] }>();
const emit = defineEmits<{ saved: [] }>();
const nowMs = useNowMs();
const tags = ref<string[]>([]);
const draft = ref("");
const busy = ref(false);
const error = ref<string | null>(null);
const view = computed(() => ideaVerdictView({ history: props.history, tags: tags.value, draft: draft.value, nowMs: nowMs.value, busy: busy.value }));
const inputId = `idea-note-${useId()}`;

const toggleTag = (value: string) => (tags.value = tags.value.includes(value) ? tags.value.filter((x) => x !== value) : [...tags.value, value]);

// Escape closes "Add why" (the draft is kept) and puts the focus back on its summary, so the keyboard can open it again with Enter.
const box = ref<HTMLDetailsElement | null>(null);
const summaryEl = ref<HTMLElement | null>(null);
function close() {
  if (box.value) box.value.open = false;
  summaryEl.value?.focus();
}

async function post(body: ReturnType<typeof oneClickBody>): Promise<boolean> {
  busy.value = true;
  error.value = null;
  const r = await submitVerdict((b) => $fetch<unknown>(`/api/proposals/${props.proposalId}/verdict`, { method: "POST", body: b }), body);
  busy.value = false;
  if (r.ok) emit("saved");
  else error.value = r.message;
  return r.ok;
}

// A click on the verdict that is already current changes nothing, so it adds no row to the history.
async function click(value: "good" | "bad") {
  if (busy.value || view.value.current?.tone === value) return;
  await post(oneClickBody(value));
}

async function saveWhy() {
  const current = view.value.current;
  if (!current || !view.value.canSaveWhy) return;
  if (await post(whyBody(current.tone, tags.value, draft.value))) {
    tags.value = [];
    draft.value = "";
    close();
  }
}
</script>

<template>
  <section class="surface grid gap-4" data-test="idea-verdict-block">
    <h3 class="section-title">Your verdict on this idea</h3>
    <p class="note muted text-sm">One click. Only Good or Bad counts: dismissing an idea says nothing about it.</p>
    <div class="flex flex-wrap gap-2" role="group" aria-label="Idea verdict">
      <button v-for="c in view.choices" :key="c.value" type="button" class="btn" :class="c.on ? (c.value === 'good' ? 'btn-success' : 'btn-danger') : 'btn-outline'" :aria-pressed="c.on" :aria-busy="busy" :data-test="`idea-${c.value}`" @click="click(c.value)">{{ c.label }}</button>
    </div>
    <div v-if="view.current" class="inset grid gap-2 p-4 text-sm" data-test="idea-verdict-current">
      <div class="flex flex-wrap items-center gap-2">
        <span class="pill" :class="view.current.tone === 'good' ? 'pill-green' : 'pill-red'" :data-tone="view.current.tone" data-test="idea-verdict-label">{{ view.current.label }}</span>
        <span v-for="t in view.current.tags" :key="t" class="pill pill-outline">{{ t }}</span>
        <span v-if="view.current.when" class="faint ml-auto text-xs">{{ view.current.when }}</span>
      </div>
      <p v-if="view.current.note" class="muted min-w-0 break-words" data-test="idea-verdict-note">{{ view.current.note }}</p>
    </div>
    <p v-else class="note muted text-sm" data-test="idea-verdict-none">No verdict yet.</p>

    <details v-if="view.current" ref="box" class="min-w-0" data-test="idea-why" @keydown.esc="close">
      <summary ref="summaryEl" class="flex min-h-11 cursor-pointer items-center text-sm font-semibold text-[var(--wr-accent-strong)]" data-test="idea-why-summary">Add why</summary>
      <form class="grid min-w-0 gap-4 pb-1" @submit.prevent="saveWhy">
        <fieldset class="grid min-w-0 gap-1">
          <legend class="faint mb-1 text-xs">What worked</legend>
          <label v-for="t in view.tagOptions.filter((o) => o.side === 'worked')" :key="t.value" class="flex min-h-11 min-w-0 items-center gap-2 text-sm">
            <input type="checkbox" :checked="t.on" :data-test="`idea-tag-${t.value}`" @change="toggleTag(t.value)" />
            <span class="min-w-0 break-words">{{ t.label }}</span>
          </label>
        </fieldset>
        <fieldset class="grid min-w-0 gap-1">
          <legend class="faint mb-1 text-xs">What did not</legend>
          <label v-for="t in view.tagOptions.filter((o) => o.side !== 'worked')" :key="t.value" class="flex min-h-11 min-w-0 items-center gap-2 text-sm">
            <input type="checkbox" :checked="t.on" :data-test="`idea-tag-${t.value}`" @change="toggleTag(t.value)" />
            <span class="min-w-0 break-words">{{ t.label }}</span>
          </label>
        </fieldset>
        <div class="grid min-w-0 gap-1.5">
          <label :for="inputId" class="faint text-xs">Note, optional. Plain text.</label>
          <textarea :id="inputId" v-model="draft" class="field min-w-0 text-sm" rows="3" data-test="idea-note" placeholder="Why?" />
          <span class="faint text-xs tabular-nums" data-test="idea-counter">{{ view.counter }}</span>
        </div>
        <div class="flex flex-wrap items-center justify-end gap-2">
          <button type="submit" class="btn btn-primary" :disabled="!view.canSaveWhy" data-test="idea-why-submit">{{ busy ? "Saving…" : "Save why" }}</button>
        </div>
      </form>
    </details>
    <p v-if="error" class="note note-amber min-w-0 break-words text-xs" role="alert" data-test="idea-verdict-error">{{ error }}</p>

    <div v-if="view.earlier.length > 0" class="grid gap-2" data-test="idea-verdict-history">
      <h4 class="faint text-xs font-semibold uppercase tracking-wide">Earlier verdicts</h4>
      <ul class="grid gap-2">
        <li v-for="v in view.earlier" :key="v.id" class="inset grid gap-1.5 px-4 py-3 text-sm" data-test="idea-verdict-earlier">
          <div class="flex flex-wrap items-center gap-2">
            <span class="pill" :class="v.tone === 'good' ? 'pill-green' : 'pill-red'">{{ v.label }}</span>
            <span v-for="t in v.tags" :key="t" class="pill pill-outline">{{ t }}</span>
            <span v-if="v.when" class="faint ml-auto text-xs">{{ v.when }}</span>
          </div>
          <p v-if="v.note" class="muted min-w-0 break-words">{{ v.note }}</p>
        </li>
      </ul>
    </div>
  </section>
</template>
