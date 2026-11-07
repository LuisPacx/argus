<script setup lang="ts">
const { data: rubric, refresh } = await useFetch("/api/rubric");
// Rows animate in when the page is reached by a client navigation; on the first (hydrating) load they are simply there.
const animate = !useNuxtApp().isHydrating;

// Editable copy of the loaded Rubric; saving sends the version it was loaded from.
const load = () => ({
  baseVersion: rubric.value?.version ?? 0,
  dimensions: (rubric.value?.dimensions ?? []).map(({ key, description, weight }) => ({ key, description, weight })),
  gateMinScore: rubric.value?.gateMinScore ?? 0,
});
const form = reactive(load());
const message = ref("");
const error = ref("");

async function reload() {
  await refresh();
  Object.assign(form, load());
}

async function save() {
  message.value = "";
  error.value = "";
  try {
    const saved = await $fetch<{ version: number }>("/api/rubric", {
      method: "PUT",
      body: { baseVersion: form.baseVersion, dimensions: form.dimensions, gateMinScore: form.gateMinScore },
    });
    await reload();
    message.value = `Saved as version ${saved.version}.`;
  } catch (e) {
    error.value = (e as { statusMessage?: string }).statusMessage ?? "Could not save the Rubric";
  }
}
</script>

<template>
  <div class="grid gap-8">
    <div>
      <h2 class="page-title">Rubric</h2>
      <p class="page-sub">Version {{ rubric?.version }}</p>
    </div>
    <form class="grid gap-4" @submit.prevent="save">
      <TransitionGroup tag="div" name="row" :appear="animate" class="relative grid gap-3">
        <div v-for="(d, i) in form.dimensions" :key="d.key" class="row row-static grid items-center gap-x-6 gap-y-3 md:grid-cols-[170px_minmax(0,1fr)_auto]" :style="{ '--i': i }">
          <div class="flex flex-wrap items-center gap-2">
            <label :for="`dim-${d.key}`" class="text-lg font-semibold capitalize tracking-tight">{{ d.key }}</label>
            <span v-if="d.key === 'buildability'" class="pill pill-amber">hard gate</span>
          </div>
          <textarea :id="`dim-${d.key}`" v-model="d.description" class="field" rows="2" />
          <label class="muted flex items-center gap-3 text-sm">
            Weight
            <input v-model.number="d.weight" type="number" min="0" step="any" class="field w-24" />
          </label>
        </div>
      </TransitionGroup>
      <label class="surface flex flex-wrap items-center gap-3 py-5 text-sm">
        <span>Gate: a Narrative scoring below</span>
        <input v-model.number="form.gateMinScore" type="number" min="0" max="10" step="any" class="field w-24" />
        <span>on buildability (0 to 10) never becomes a Proposal</span>
      </label>
      <p v-if="error" class="note note-red">{{ error }}</p>
      <p v-if="message" class="note note-green">{{ message }}</p>
      <div class="flex gap-2">
        <button type="submit" class="btn btn-primary px-6 py-3">Save Rubric</button>
        <button type="button" class="btn btn-outline px-6 py-3" @click="reload">Discard changes</button>
      </div>
    </form>
  </div>
</template>
