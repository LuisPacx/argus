<script setup lang="ts">
const route = useRoute();
const id = route.params.id;
const { data: p, refresh } = await useFetch(`/api/proposals/${id}`);
const { data: commands, refresh: refreshCommands } = await useFetch("/api/commands", { default: () => [] });

const text = ref("");
const baseHash = ref("");
const loadedFor = ref<string | null>(null);
const message = ref("");
const error = ref("");
const instruction = ref("");
const sending = ref(false);

async function loadSpec() {
  error.value = "";
  try {
    const spec = await $fetch<{ content: string; hash: string }>(`/api/proposals/${id}/spec`);
    text.value = spec.content;
    baseHash.value = spec.hash;
    loadedFor.value = spec.hash;
  } catch (e) {
    error.value = (e as { statusMessage?: string }).statusMessage ?? "Could not load the Spec";
  }
}
if (p.value?.specHash) await loadSpec();

const pending = computed(() => commands.value.some((c) => c.proposalId === p.value?.id && c.status === "pending"));
const working = computed(() => !!p.value?.brainRunInFlightSince || !!p.value?.specRevision || pending.value);

let timer: ReturnType<typeof setInterval> | undefined;
onMounted(() => {
  timer = setInterval(() => void Promise.all([refresh(), refreshCommands()]), 3000);
});
onBeforeUnmount(() => clearInterval(timer));

// Build log: tail build.log by byte offset while the Build runs, keep the last chunk of it on screen.
const LOG_STATUSES = ["building", "built", "build-failed", "needs-human"];
const logText = ref("");
let logOffset = 0;
async function tailLog() {
  if (!LOG_STATUSES.includes(p.value?.status ?? "")) return;
  try {
    const r = await $fetch<{ content: string; offset: number }>(`/api/proposals/${id}/build-log`, { query: { offset: logOffset } });
    if (r.offset < logOffset) logText.value = "";
    logOffset = r.offset;
    logText.value = (logText.value + r.content).slice(-200_000);
  } catch {
    // the next poll retries
  }
}
let logTimer: ReturnType<typeof setInterval> | undefined;
onMounted(() => {
  void tailLog();
  logTimer = setInterval(() => void tailLog(), 2000);
});
onBeforeUnmount(() => clearInterval(logTimer));
// A revision landed: load the new Spec unless the Operator has unsaved edits in the box.
const edited = ref(false);
watch(
  () => p.value?.specHash,
  (hash) => {
    if (hash && hash !== baseHash.value && !edited.value) void loadSpec();
  },
);

async function save() {
  message.value = "";
  error.value = "";
  try {
    const res = await $fetch<{ hash: string }>(`/api/proposals/${id}/spec`, {
      method: "PUT",
      body: { content: text.value, baseHash: baseHash.value },
    });
    baseHash.value = res.hash;
    edited.value = false;
    message.value = "Saved.";
    await refresh();
  } catch (e) {
    error.value = (e as { statusMessage?: string }).statusMessage ?? "Could not save";
  }
}

async function send(type: "revise" | "approve" | "retry-spec" | "requeue", reason = "") {
  if (sending.value || working.value) return;
  sending.value = true;
  message.value = "";
  error.value = "";
  try {
    await $fetch(`/api/proposals/${id}/commands`, { method: "POST", body: { type, reason } });
    if (type === "revise") instruction.value = "";
    await refreshCommands();
  } catch (e) {
    error.value = (e as { statusMessage?: string }).statusMessage ?? "Could not send command";
  } finally {
    sending.value = false;
  }
}
</script>

<template>
  <UCard v-if="p">
    <template #header>
      <div class="flex items-center justify-between">
        <h2 class="text-xl font-semibold">{{ p.name }} ({{ p.ticker }})</h2>
        <UBadge>{{ p.status }}</UBadge>
      </div>
    </template>
    <dl class="grid gap-2">
      <dt class="font-semibold">Narrative summary</dt>
      <dd>{{ p.narrativeSummary }}</dd>
      <dt class="font-semibold">Tech one-liner</dt>
      <dd>{{ p.techOneLiner }}</dd>
      <dt class="font-semibold">Why now</dt>
      <dd>{{ p.whyNow }}</dd>
      <dt class="font-semibold">Description</dt>
      <dd>{{ p.description }}</dd>
      <dt class="font-semibold">Evidence links</dt>
      <dd>
        <ul>
          <li v-for="link in p.evidenceLinks" :key="link">
            <a :href="link" target="_blank" rel="noopener">{{ link }}</a>
          </li>
        </ul>
      </dd>
      <dt class="font-semibold">Slug</dt>
      <dd>{{ p.slug }}</dd>
      <dt class="font-semibold" title="API-equivalent estimate reported by claude -p. Runs use the Claude subscription; this is not a charge.">Est. usage (API-equiv.)</dt>
      <dd>${{ p.agentCostUsd.toFixed(2) }}</dd>
      <dt class="font-semibold">Created</dt>
      <dd>{{ p.createdAt }}</dd>
      <dt class="font-semibold">Updated</dt>
      <dd>{{ p.updatedAt }}</dd>
    </dl>
    <section v-if="p.status === 'shortlisted' && p.specError" class="mt-4">
      <p class="text-sm text-red-500">{{ p.specError }}</p>
      <UButton class="mt-2" size="sm" :disabled="working || sending" @click="send('retry-spec')">Retry Spec</UButton>
    </section>
    <section v-if="p.status === 'build-failed'" class="mt-4 grid gap-2">
      <p class="text-sm text-red-500">The Build failed after its retry.</p>
      <template v-if="p.resumeCommand">
        <p class="text-sm">To continue its session, run in tmux on the host:</p>
        <pre class="overflow-auto whitespace-pre-wrap text-xs">{{ p.resumeCommand }}</pre>
      </template>
      <p class="text-sm text-muted">Re-queue starts a fresh Build: first remove ~/code/{{ p.slug }}, the private GitHub repo {{ p.slug }}<template v-if="p.workerDeployed"> and the Cloudflare Worker {{ p.slug }} (the Build deployed it)</template>. Re-queue is refused while the directory or the repo is still there.</p>
      <div><UButton size="sm" :disabled="working || sending" @click="send('requeue')">Re-queue</UButton></div>
    </section>
    <section v-if="p.status === 'spec-drafted' && loadedFor" class="mt-4 grid gap-2">
      <h3 class="font-semibold">Spec</h3>
      <UTextarea v-model="text" :rows="24" class="font-mono" @update:model-value="edited = true" />
      <div class="flex flex-wrap items-center gap-2">
        <UButton size="sm" :disabled="!text.trim()" @click="save">Save</UButton>
        <UButton size="sm" variant="outline" @click="edited = false; loadSpec()">Reload</UButton>
        <UButton size="sm" color="success" :disabled="working || sending || edited" @click="send('approve')">Approve</UButton>
      </div>
      <div class="flex flex-wrap items-center gap-2">
        <UInput v-model="instruction" class="grow" placeholder="Ask the agent to revise the Spec..." :maxlength="4000" />
        <UButton size="sm" :disabled="!instruction.trim() || working || sending || edited" @click="send('revise', instruction)">Revise</UButton>
      </div>
      <p v-if="edited" class="text-xs text-muted">Save your edits before revising or approving.</p>
      <p v-if="working" class="text-sm text-amber-500">Working... the agent is revising or a command is pending.</p>
      <p v-if="p.specError" class="text-sm text-red-500">{{ p.specError }}</p>
      <p v-if="message" class="text-sm text-green-600">{{ message }}</p>
      <p v-if="error" class="text-sm text-red-500">{{ error }}</p>
    </section>
    <p v-if="p.approvedAt" class="mt-4 text-sm">Approved {{ p.approvedAt }}</p>
    <p v-if="p.previewUrl" class="mt-4 text-sm">
      Preview: <a :href="p.previewUrl" target="_blank" rel="noopener">{{ p.previewUrl }}</a>
    </p>
    <section v-if="logText" class="mt-4">
      <h3 class="font-semibold">Build log</h3>
      <pre class="max-h-96 overflow-auto text-xs whitespace-pre-wrap">{{ logText }}</pre>
    </section>
  </UCard>
  <p v-else>Proposal not found.</p>
</template>
