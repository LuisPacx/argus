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

const mint = ref("");

async function send(type: "revise" | "approve" | "retry-spec" | "requeue" | "mark-launched", reason = "") {
  if (sending.value || working.value) return;
  sending.value = true;
  message.value = "";
  error.value = "";
  try {
    await $fetch(`/api/proposals/${id}/commands`, { method: "POST", body: { type, reason } });
    if (type === "revise") instruction.value = "";
    if (type === "mark-launched") mint.value = "";
    await refreshCommands();
  } catch (e) {
    error.value = (e as { statusMessage?: string }).statusMessage ?? "Could not send command";
  } finally {
    sending.value = false;
  }
}
</script>

<template>
  <div v-if="p" class="grid gap-6">
    <NuxtLink to="/" class="link inline-flex items-center gap-2 justify-self-start text-sm font-medium">
      <svg class="size-4" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M13 8H3M7 4 3 8l4 4" /></svg>
      Back to Proposals
    </NuxtLink>

    <div class="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_380px]">
      <div class="grid min-w-0 gap-5">
        <section class="surface rise" style="--i: 0">
          <div class="flex flex-wrap items-center gap-x-3 gap-y-2">
            <h2 class="page-title">{{ p.name }}</h2>
            <span class="faint text-sm font-medium uppercase tracking-wide">{{ p.ticker }}</span>
            <StatusPill :status="p.status" />
            <span v-if="p.score" class="pill pill-accent ml-auto px-3.5 py-2 text-base tabular-nums">{{ p.score.total.toFixed(1) }}<span class="text-xs font-medium opacity-70">/10</span></span>
          </div>
          <div class="mt-6 grid gap-5">
            <div><p class="eyebrow mb-1.5">Narrative summary</p><p class="whitespace-pre-line leading-relaxed">{{ p.narrativeSummary }}</p></div>
            <div><p class="eyebrow mb-1.5">Tech one-liner</p><p class="leading-relaxed">{{ p.techOneLiner }}</p></div>
            <div><p class="eyebrow mb-1.5">Why now</p><p class="leading-relaxed">{{ p.whyNow }}</p></div>
            <div><p class="eyebrow mb-1.5">Description</p><p class="whitespace-pre-line leading-relaxed">{{ p.description }}</p></div>
          </div>
        </section>

        <section v-if="p.narrativeId !== null" class="surface rise" style="--i: 1">
          <h3 class="section-title">Narrative</h3>
          <p class="mt-3 text-sm">
            <NuxtLink :to="`/narratives/${p.narrativeId}`" class="link font-medium">Narrative {{ p.narrativeId }}</NuxtLink>
            <span class="muted"> started {{ p.narrativeCreatedAt ? fmtWhen(p.narrativeCreatedAt) : "" }}</span>
          </p>
        </section>

        <section class="surface rise" style="--i: 2">
          <h3 class="section-title">Evidence links</h3>
          <ul class="mt-4 grid gap-2.5">
            <li v-for="link in p.evidenceLinks" :key="link" class="inset flex min-w-0 items-center px-4 py-3 text-sm">
              <UrlLink :href="link" />
            </li>
          </ul>
        </section>

        <section v-if="p.status === 'shortlisted' && p.specError" class="surface grid gap-3">
          <h3 class="section-title">Spec</h3>
          <p class="note note-red">{{ p.specError }}</p>
          <div><button class="btn btn-primary" :disabled="working || sending" @click="send('retry-spec')">Retry Spec</button></div>
        </section>

        <section v-if="p.status === 'build-failed'" class="surface grid gap-3">
          <h3 class="section-title">Build</h3>
          <p class="note note-red">The Build failed after its retry.</p>
          <template v-if="p.resumeCommand">
            <p class="note">To continue its session, run in tmux on the host:</p>
            <pre class="inset overflow-auto whitespace-pre-wrap p-3 text-xs">{{ p.resumeCommand }}</pre>
          </template>
          <p class="note muted">Re-queue starts a fresh Build: first remove ~/code/{{ p.slug }}, the private GitHub repo {{ p.slug }}<template v-if="p.workerDeployed"> and the Cloudflare Worker {{ p.slug }} (the Build deployed it)</template>. Re-queue is refused while the directory or the repo is still there.</p>
          <div><button class="btn btn-primary" :disabled="working || sending" @click="send('requeue')">Re-queue</button></div>
        </section>

        <section v-if="p.status === 'built' && p.launchUrl" class="surface grid gap-3">
          <h3 class="section-title">Launch</h3>
          <p class="note muted">Opens newpairspam's token form prefilled. Launch there, then come back and record the mint. argus never touches a chain.</p>
          <div><NuxtLink class="btn btn-primary" :to="p.launchUrl" target="_blank" rel="noopener">Launch in newpairspam</NuxtLink></div>
          <div class="flex flex-wrap gap-2">
            <input v-model="mint" class="field w-96 max-w-full" placeholder="Mint address" :disabled="working || sending" />
            <button class="btn btn-primary" :disabled="working || sending || !mint.trim()" @click="send('mark-launched', mint.trim())">Mark launched</button>
          </div>
          <p v-if="error" class="note note-red">{{ error }}</p>
        </section>

        <p v-if="p.status === 'launched' && p.mint" class="surface note">Launched. Mint: <code class="break-all">{{ p.mint }}</code></p>

        <section v-if="p.status === 'spec-drafted' && loadedFor" class="surface grid gap-3">
          <div class="flex items-center justify-between"><h3 class="section-title">Spec</h3><span class="pill pill-accent">Draft</span></div>
          <textarea v-model="text" class="field font-mono text-[0.8rem] leading-relaxed" rows="24" @input="edited = true" />
          <div class="flex flex-wrap items-center gap-2">
            <button class="btn btn-primary" :disabled="!text.trim()" @click="save">Save</button>
            <button class="btn btn-outline" @click="edited = false; loadSpec()">Reload</button>
            <button class="btn btn-success" :disabled="working || sending || edited" @click="send('approve')">Approve</button>
          </div>
          <div class="flex flex-wrap items-center gap-2 border-t border-[var(--wr-line)] pt-4">
            <input v-model="instruction" class="field min-w-0 flex-1" placeholder="Ask the agent to revise the Spec..." maxlength="4000" />
            <button class="btn btn-primary" :disabled="!instruction.trim() || working || sending || edited" @click="send('revise', instruction)">Revise</button>
          </div>
          <p v-if="edited" class="note faint">Save your edits before revising or approving.</p>
          <p v-if="working" class="note note-amber">Working... the agent is revising or a command is pending.</p>
          <p v-if="p.specError" class="note note-red">{{ p.specError }}</p>
          <p v-if="message" class="note note-green">{{ message }}</p>
          <p v-if="error" class="note note-red">{{ error }}</p>
        </section>

        <p v-if="p.approvedAt" class="surface note">Approved {{ p.approvedAt }}</p>
        <section v-if="p.previewUrl" class="surface">
          <h3 class="section-title">Preview</h3>
          <p class="mt-3 flex min-w-0 text-sm"><UrlLink :href="p.previewUrl" /></p>
        </section>
        <section v-if="logText" class="surface">
          <h3 class="section-title">Build log</h3>
          <pre class="inset mt-3 max-h-96 overflow-auto whitespace-pre-wrap p-4 text-xs">{{ logText }}</pre>
        </section>
      </div>

      <aside class="grid min-w-0 gap-5">
        <section v-if="p.score" class="surface rise" style="--i: 1">
          <div class="mb-5 flex items-baseline justify-between gap-3">
            <h3 class="section-title">Score</h3>
            <span class="faint text-xs">Rubric version {{ p.score.rubricVersion }}</span>
          </div>
          <ScoreBars :scores="p.score.scores" />
          <p class="muted mt-5 border-t border-[var(--wr-line)] pt-4 text-sm leading-relaxed">{{ p.score.rationale }}</p>
        </section>

        <section class="surface rise" style="--i: 2">
          <h3 class="section-title mb-4">Collision checks</h3>
          <CollisionChecks :collisions="p.collisions" />
        </section>

        <section class="surface rise" style="--i: 3">
          <h3 class="section-title mb-2">Details</h3>
          <dl class="kv">
            <div><dt>Slug</dt><dd class="font-mono text-[0.8rem]">{{ p.slug }}</dd></div>
            <div><dt title="API-equivalent estimate reported by claude -p. Runs use the Claude subscription; this is not a charge.">Est. usage (API-equiv.)</dt><dd>${{ p.agentCostUsd.toFixed(2) }}</dd></div>
            <div v-if="p.apiCostUsd > 0"><dt title="Real money billed by the Anthropic API for this Proposal's fallback runs. Not part of Est. usage.">API spend (real $)</dt><dd data-test="api-cost">${{ p.apiCostUsd.toFixed(4) }}</dd></div>
            <div><dt>Created</dt><dd :title="p.createdAt">{{ fmtWhen(p.createdAt) }}</dd></div>
            <div><dt>Updated</dt><dd :title="p.updatedAt">{{ fmtWhen(p.updatedAt) }}</dd></div>
            <div v-if="p.expiresAt"><dt>Expires</dt><dd :title="p.expiresAt">{{ fmtWhen(p.expiresAt) }}</dd></div>
          </dl>
        </section>

        <section v-if="p.brainRuns.length > 0" class="surface rise" style="--i: 4">
          <h3 class="section-title mb-4">Brain runs</h3>
          <ul class="grid gap-2.5" data-test="brain-runs">
            <li v-for="r in p.brainRuns" :key="r.id" class="inset grid gap-1.5 px-4 py-3 text-sm">
              <div class="flex flex-wrap items-center gap-1.5">
                <span class="font-semibold">{{ r.task }}</span>
                <span class="pill pill-outline" :data-backend="r.backend">{{ r.backend }}</span>
                <span class="pill pill-outline">{{ r.model }}</span>
                <span class="pill" :class="r.exitStatus === 'success' ? 'pill-green' : r.exitStatus === 'in-flight' ? 'pill-accent' : 'pill-red'">{{ r.exitStatus }}</span>
              </div>
              <span class="muted text-xs">{{ r.backend === "api" ? `$${r.totalCostUsd.toFixed(4)} real` : `$${r.totalCostUsd.toFixed(2)} est.` }}</span>
            </li>
          </ul>
        </section>
      </aside>
    </div>
  </div>
  <p v-else class="surface muted">Proposal not found.</p>
</template>
