<script setup lang="ts">
// An in-app confirmation dialog (never window.confirm). Esc and a click on the backdrop cancel; focus moves to Cancel on open, is kept
// inside while open, and returns to whatever opened it on close. Browser APIs are touched only in onMounted, watchers (client-side
// changes) and event handlers, so SSR renders it as nothing (it is closed on the server).
const props = defineProps<{
  open: boolean;
  title: string;
  confirmLabel: string;
  busy?: boolean;
  error?: string;
}>();
const emit = defineEmits<{ confirm: []; cancel: [] }>();

const uid = useId();
const dialog = ref<HTMLElement>();
const cancelButton = ref<HTMLButtonElement>();
let opener: HTMLElement | null = null;

const focusables = () => Array.from(dialog.value?.querySelectorAll<HTMLElement>("button:not(:disabled)") ?? []);

watch(
  () => props.open,
  async (open) => {
    if (open) {
      opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      await nextTick();
      cancelButton.value?.focus();
    } else {
      await nextTick();
      if (opener?.isConnected) opener.focus();
      opener = null;
    }
  },
  { flush: "pre" },
);

function onKeydown(e: KeyboardEvent) {
  if (!props.open) return;
  if (e.key === "Escape") {
    e.preventDefault();
    emit("cancel");
    return;
  }
  if (e.key !== "Tab") return;
  const items = focusables();
  if (items.length === 0) return;
  const first = items[0]!;
  const last = items[items.length - 1]!;
  const active = document.activeElement;
  if (!dialog.value?.contains(active)) {
    e.preventDefault();
    first.focus();
  } else if (e.shiftKey && active === first) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && active === last) {
    e.preventDefault();
    first.focus();
  }
}
onMounted(() => document.addEventListener("keydown", onKeydown));
onBeforeUnmount(() => document.removeEventListener("keydown", onKeydown));
</script>

<template>
  <Teleport to="body">
    <Transition name="modal">
      <div v-if="open" class="modal-backdrop" data-test="confirm-modal" @click.self="emit('cancel')">
        <div ref="dialog" class="modal-panel surface" role="dialog" aria-modal="true" :aria-labelledby="`${uid}-title`" :aria-describedby="`${uid}-body`">
          <h3 :id="`${uid}-title`" class="section-title">{{ title }}</h3>
          <div :id="`${uid}-body`" class="muted mt-3 grid gap-2 text-sm leading-relaxed"><slot /></div>
          <p v-if="error" class="note note-red mt-3" role="alert">{{ error }}</p>
          <div class="mt-6 flex flex-wrap justify-end gap-2">
            <button ref="cancelButton" type="button" class="btn btn-ghost" data-test="confirm-cancel" @click="emit('cancel')">Cancel</button>
            <button type="button" class="btn btn-primary" :disabled="busy" data-test="confirm-ok" @click="emit('confirm')">{{ confirmLabel }}</button>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>
