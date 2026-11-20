<script setup lang="ts">
// /research (human researcher ticket 03): the Operator pastes contract addresses with an optional reason and topic; the server looks each coin up on
// DexScreener and records a Pick with a snapshot of it. The form posts `{ text, reason, topic }` to POST /api/picks and shows what the server said for
// each line; the server does every check. The list below is GET /api/picks. Everything shown is text.
import { canSubmitPicks, picksView, REASON_MAX_CHARS, submitPicks, TOPIC_MAX_CHARS, type PickLineView, type PicksAccepted } from "../utils/research.ts";

const { data, refresh } = await useFetch("/api/picks", { default: () => [] });
const nowMs = useNowMs();
const view = computed(() => picksView(data.value, nowMs.value));

const text = ref("");
const reason = ref("");
const topic = ref("");
const busy = ref(false);
const error = ref<string | null>(null);
const lines = ref<PickLineView[]>([]);
const note = ref<string | null>(null);
const canSubmit = computed(() => canSubmitPicks(text.value) && !busy.value);

async function submit() {
  if (!canSubmit.value) return;
  busy.value = true;
  error.value = null;
  const r = await submitPicks((body) => $fetch<PicksAccepted>("/api/picks", { method: "POST", body }), { text: text.value, reason: reason.value, topic: topic.value });
  busy.value = false;
  if (!r.ok) {
    error.value = r.message;
    return;
  }
  lines.value = r.lines;
  note.value = r.note;
  // Keep the text of lines that were not recorded so the Operator can fix them; clear the box when every line went in.
  if (r.lines.every((l) => l.ok)) text.value = "";
  await refresh();
}
</script>

<template>
  <div class="grid gap-6">
    <h2 class="page-title">Research</h2>
    <p class="note muted">
      Paste the contract address of a coin you think is valuable. Argus looks it up on DexScreener and records a Pick with the coin as it is right now: name, ticker, market cap, liquidity, age and whether it has bonded. One address per line or
      separated by spaces. The same coin can be picked again after 24 hours. No model is called here.
    </p>

    <form class="surface grid min-w-0 gap-3" data-test="pick-form" @submit.prevent="submit">
      <label for="pick-text" class="text-sm font-medium">Contract addresses</label>
      <textarea id="pick-text" v-model="text" class="field min-w-0 font-mono text-sm" rows="4" maxlength="2000" data-test="pick-text" placeholder="One or more Solana contract addresses" @keydown.enter.exact.prevent="submit" />
      <p class="faint text-xs">Enter records the Picks; Shift+Enter starts a new line.</p>
      <div class="grid min-w-0 gap-3 sm:grid-cols-2">
        <div class="grid min-w-0 gap-1">
          <label for="pick-topic" class="faint text-xs">Topic (optional)</label>
          <input id="pick-topic" v-model="topic" class="field min-w-0 text-sm" type="text" :maxlength="TOPIC_MAX_CHARS" data-test="pick-topic-input" placeholder="For example GTA" />
        </div>
        <div class="grid min-w-0 gap-1">
          <label for="pick-reason" class="faint text-xs">Reason (optional)</label>
          <input id="pick-reason" v-model="reason" class="field min-w-0 text-sm" type="text" :maxlength="REASON_MAX_CHARS" data-test="pick-reason-input" placeholder="Why this coin?" />
        </div>
      </div>
      <div class="flex flex-wrap items-center justify-end gap-2">
        <button type="submit" class="btn btn-primary" :disabled="!canSubmit" data-test="pick-submit">{{ busy ? "Looking up…" : "Record Picks" }}</button>
      </div>
      <p v-if="error" class="note note-amber min-w-0 break-words text-xs" role="alert" data-test="pick-error">{{ error }}</p>
      <ul v-if="lines.length > 0" class="grid min-w-0 gap-1" role="status" data-test="pick-results">
        <li v-for="(l, i) in lines" :key="i" class="note min-w-0 break-words text-xs" :class="l.ok ? 'note-green' : 'note-amber'" :data-ok="l.ok" data-test="pick-result">
          <span class="break-all font-mono">{{ l.text }}</span>: {{ l.message }}
        </li>
      </ul>
      <p v-if="note" class="muted min-w-0 break-words text-xs" data-test="pick-note">{{ note }}</p>
    </form>

    <PickList :view="view" />
  </div>
</template>
