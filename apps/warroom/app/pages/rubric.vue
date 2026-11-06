<script setup lang="ts">
const { data: rubric, refresh } = await useFetch("/api/rubric");

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
  <UCard>
    <template #header>Rubric (version {{ rubric?.version }})</template>
    <form class="grid gap-4" @submit.prevent="save">
      <div v-for="d in form.dimensions" :key="d.key" class="grid gap-1">
        <label class="font-semibold">{{ d.key }}<span v-if="d.key === 'buildability'"> (hard gate)</span></label>
        <UTextarea v-model="d.description" />
        <label class="text-sm">Weight <input v-model.number="d.weight" type="number" min="0" step="any" class="w-24 border px-1" /></label>
      </div>
      <label class="text-sm">
        Gate: a Narrative scoring below
        <input v-model.number="form.gateMinScore" type="number" min="0" max="10" step="any" class="w-24 border px-1" />
        on buildability (0 to 10) never becomes a Proposal
      </label>
      <p v-if="error" class="text-sm text-red-500">{{ error }}</p>
      <p v-if="message" class="text-sm">{{ message }}</p>
      <div class="flex gap-2">
        <UButton type="submit">Save Rubric</UButton>
        <UButton variant="ghost" @click="reload">Discard changes</UButton>
      </div>
    </form>
  </UCard>
</template>
