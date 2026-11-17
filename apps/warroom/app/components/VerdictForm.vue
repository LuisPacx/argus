<script setup lang="ts">
// The Operator's Verdict on a Narrative (War Room ticket 19), on /narratives/<id>: the current verdict and the ones it replaced, and a form (good or
// bad, reason tags, the Rubric dimensions when a score tag is on, a note of at most 500 characters). The form posts the choice to
// POST /api/narratives/<id>/verdict and shows what the server said; the server does every check, and the Score and Rubric version it is
// stored against are read there, never sent. Everything shown is text (the note is a textarea value and a clamped line). Template-only names
// (for server/test/narrative-verdict-render.test.ts, which renders the template): view, busy, error, inputId, pick, toggleTag, toggleDimension,
// submit, close, box, summaryEl.
import { useId } from "vue";
import { submitVerdict, verdictBody, verdictFormView, type VerdictPayload } from "../utils/verdict.ts";

const props = defineProps<{ narrativeId: number; history: VerdictPayload[] }>();
const nowMs = useNowMs();
const choice = ref<string | null>(null);
const tags = ref<string[]>([]);
const dimensions = ref<string[]>([]);
const draft = ref("");
const busy = ref(false);
const error = ref<string | null>(null);
const view = computed(() => verdictFormView({ history: props.history, choice: choice.value, tags: tags.value, dimensions: dimensions.value, draft: draft.value, nowMs: nowMs.value, busy: busy.value }));
const inputId = `verdict-note-${useId()}`;

const flip = (list: string[], value: string) => (list.includes(value) ? list.filter((x) => x !== value) : [...list, value]);
const pick = (value: string) => (choice.value = value);
const toggleTag = (value: string) => (tags.value = flip(tags.value, value));
const toggleDimension = (value: string) => (dimensions.value = flip(dimensions.value, value));

// Escape closes the form (the draft is kept) and puts the focus back on its summary, so the keyboard can open it again with Enter.
const box = ref<HTMLDetailsElement | null>(null);
const summaryEl = ref<HTMLElement | null>(null);
function close() {
  if (box.value) box.value.open = false;
  summaryEl.value?.focus();
}

async function submit() {
  if (!view.value.canSubmit) return;
  busy.value = true;
  error.value = null;
  const r = await submitVerdict((body) => $fetch<unknown>(`/api/narratives/${props.narrativeId}/verdict`, { method: "POST", body }), verdictBody({ choice: choice.value, tags: tags.value, dimensions: dimensions.value, draft: draft.value }));
  busy.value = false;
  if (r.ok) {
    choice.value = null;
    tags.value = [];
    dimensions.value = [];
    draft.value = "";
    close();
    await refreshNuxtData(`narrative-${props.narrativeId}`);
  } else error.value = r.message;
}
</script>

<template>
  <section class="surface rise grid gap-4" style="--i: 1" data-test="verdict-block">
    <h3 class="section-title">Your verdict</h3>
    <div v-if="view.current" class="inset grid gap-2 p-4 text-sm" data-test="verdict-current">
      <div class="flex flex-wrap items-center gap-2">
        <span class="pill" :class="view.current.tone === 'good' ? 'pill-green' : 'pill-red'" :data-tone="view.current.tone" data-test="verdict-current-label">{{ view.current.label }}</span>
        <span v-for="t in view.current.tags" :key="t" class="pill pill-outline">{{ t }}</span>
        <span v-for="d in view.current.dimensions" :key="d" class="pill pill-ink capitalize">{{ d }}</span>
        <span class="faint ml-auto text-xs">{{ view.current.against }}<template v-if="view.current.when"> · {{ view.current.when }}</template></span>
      </div>
      <p v-if="view.current.note" class="muted min-w-0 break-words" data-test="verdict-current-note">{{ view.current.note }}</p>
    </div>
    <p v-else class="note muted text-sm" data-test="verdict-none">No verdict yet.</p>

    <details ref="box" class="min-w-0" data-test="verdict-form" @keydown.esc="close">
      <summary ref="summaryEl" class="flex min-h-11 cursor-pointer items-center text-sm font-semibold text-[var(--wr-accent-strong)]" data-test="verdict-summary">{{ view.current ? "Change the verdict" : "Record a verdict" }}</summary>
      <form class="grid min-w-0 gap-4 pb-1" @submit.prevent="submit">
        <div class="flex flex-wrap gap-2" role="group" aria-label="Verdict">
          <button v-for="c in view.choices" :key="c.value" type="button" class="btn" :class="c.on ? (c.value === 'good' ? 'btn-success' : 'btn-danger') : 'btn-outline'" :aria-pressed="c.on" :data-test="`verdict-${c.value}`" @click="pick(c.value)">{{ c.label }}</button>
        </div>
        <fieldset class="grid min-w-0 gap-2">
          <legend class="faint mb-1 text-xs">Reason tags, optional</legend>
          <label v-for="t in view.tagOptions" :key="t.value" class="flex min-h-11 min-w-0 items-center gap-2 text-sm">
            <input type="checkbox" :checked="t.on" :data-test="`tag-${t.value}`" @change="toggleTag(t.value)" />
            <span class="min-w-0 break-words">{{ t.label }}<span v-if="t.hint" class="faint"> ({{ t.hint }})</span></span>
          </label>
        </fieldset>
        <fieldset v-if="view.showDimensions" class="grid min-w-0 gap-2" data-test="verdict-dimensions">
          <legend class="faint mb-1 text-xs">Which Rubric dimensions were off?</legend>
          <div class="flex flex-wrap gap-x-4">
            <label v-for="d in view.dimensionOptions" :key="d.value" class="flex min-h-11 items-center gap-2 text-sm capitalize">
              <input type="checkbox" :checked="d.on" :data-test="`dimension-${d.value}`" @change="toggleDimension(d.value)" />
              <span>{{ d.label }}</span>
            </label>
          </div>
        </fieldset>
        <div class="grid min-w-0 gap-1.5">
          <label :for="inputId" class="faint text-xs">Note, optional. Plain text.</label>
          <textarea :id="inputId" v-model="draft" class="field min-w-0 text-sm" rows="3" data-test="verdict-note" placeholder="Why?" />
          <span class="faint text-xs tabular-nums" data-test="verdict-counter">{{ view.counter }}</span>
        </div>
        <div class="flex flex-wrap items-center justify-end gap-2">
          <button type="submit" class="btn btn-primary" :disabled="!view.canSubmit" data-test="verdict-submit">{{ busy ? "Saving…" : "Save verdict" }}</button>
        </div>
        <p v-if="error" class="note note-amber min-w-0 break-words text-xs" role="alert" data-test="verdict-error">{{ error }}</p>
      </form>
    </details>

    <div v-if="view.earlier.length > 0" class="grid gap-2" data-test="verdict-history">
      <h4 class="faint text-xs font-semibold uppercase tracking-wide">Earlier verdicts</h4>
      <ul class="grid gap-2">
        <li v-for="v in view.earlier" :key="v.id" class="inset grid gap-1.5 px-4 py-3 text-sm" data-test="verdict-earlier">
          <div class="flex flex-wrap items-center gap-2">
            <span class="pill" :class="v.tone === 'good' ? 'pill-green' : 'pill-red'">{{ v.label }}</span>
            <span v-for="t in v.tags" :key="t" class="pill pill-outline">{{ t }}</span>
            <span class="faint ml-auto text-xs">{{ v.against }}<template v-if="v.when"> · {{ v.when }}</template></span>
          </div>
          <p v-if="v.note" class="muted min-w-0 break-words">{{ v.note }}</p>
        </li>
      </ul>
    </div>
  </section>
</template>
