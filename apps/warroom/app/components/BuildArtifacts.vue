<script setup lang="ts">
// What a dead Build left outside argus (Worker, repo, checkout) and what the last "Clean up build" did. Text only (`{{ }}`, no raw HTML):
// the paths and names come from the datastore and the disk. Template-only on purpose: server/test/cleanup-view.test.ts renders it.
import type { CleanupView } from "../utils/cleanup-view.ts";
defineProps<{ view: CleanupView; disabled: boolean }>();
defineEmits<{ open: [] }>();
</script>

<template>
  <section class="surface grid gap-3" data-test="build-artifacts">
    <h3 class="section-title">Build artifacts</h3>
    <ul v-if="view.plan" class="grid gap-1 text-sm" data-test="artifact-list">
      <li data-test="artifact-worker">Worker <code>{{ view.plan.worker.name }}</code>: {{ view.plan.worker.found ? "found" : "not found" }}</li>
      <li data-test="artifact-repo">GitHub repo <code>{{ view.plan.repo.name ?? "(none recorded)" }}</code>: {{ view.plan.repo.found ? "found" : "not found" }}</li>
      <li data-test="artifact-directory">Directory <code class="break-all">{{ view.plan.directory.path }}</code>: {{ view.plan.directory.found ? "found" : "not found" }}</li>
    </ul>
    <p v-if="view.refusal" class="note muted" data-test="cleanup-refusal">{{ view.refusal }}</p>
    <template v-if="view.results.length > 0">
      <p class="note">Last clean-up:</p>
      <ul class="grid gap-1 text-sm" data-test="cleanup-results">
        <li v-for="line in view.results" :key="line" :class="line.includes(' failed: ') ? 'note-red' : ''">{{ line }}</li>
      </ul>
    </template>
    <p v-if="view.cleaned" class="note note-green" data-test="cleanup-done">Cleaned up: nothing of this Build is left to remove.</p>
    <div v-if="view.available"><button type="button" class="btn" :disabled="disabled" data-test="cleanup-open" @click="$emit('open')">Clean up build</button></div>
  </section>
</template>
