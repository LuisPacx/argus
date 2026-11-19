<script setup lang="ts">
const route = useRoute();
const NAV = [
  { to: "/", label: "Proposals" },
  { to: "/narratives", label: "Narratives" },
  { to: "/meta", label: "Meta" },
  { to: "/moments", label: "Moments" },
  { to: "/radar", label: "Radar" },
  { to: "/activity", label: "Activity" },
  { to: "/pipeline", label: "How it works" },
  { to: "/study", label: "Study" },
  { to: "/rubric", label: "Rubric" },
];
// Proposals stays lit on a Proposal's own page, Narratives on a Narrative's.
const active = (to: string) => (to === "/" ? route.path === "/" || route.path.startsWith("/proposals") : route.path.startsWith(to));

// Below lg the nav is a swipeable row: keep the active page in view on load and on navigation.
const nav = ref<HTMLElement | null>(null);
async function showActive(smooth: boolean) {
  await nextTick();
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  nav.value?.querySelector("a[aria-current]")?.scrollIntoView({ inline: "center", block: "nearest", behavior: smooth && !reduce ? "smooth" : "auto" });
}
// The browser's own focus scroll can stop with the last item still under the edge fade; centre the focused link.
function onFocusin(e: FocusEvent) {
  (e.target as HTMLElement).scrollIntoView?.({ inline: "center", block: "nearest", behavior: "instant" });
}
onMounted(() => showActive(false));
watch(() => route.path, () => showActive(true));
</script>

<template>
  <UApp>
    <div class="mx-auto w-full max-w-[1240px] px-5 pb-16 pt-8 sm:px-8 xl:px-0">
      <header class="mb-10 flex flex-wrap items-center justify-between gap-x-6 gap-y-4 lg:grid lg:grid-cols-[1fr_auto_1fr]">
        <NuxtLink to="/" class="text-lg font-bold tracking-tight">Argus War Room</NuxtLink>
        <nav class="order-last w-full min-w-0 max-w-full rounded-full bg-white shadow-[var(--wr-shadow)] lg:order-none lg:w-auto" aria-label="Main">
          <div ref="nav" @focusin="onFocusin" class="nav-scroll flex gap-1 overflow-x-auto rounded-full p-1.5">
            <NuxtLink v-for="item in NAV" :key="item.to" :to="item.to" class="nav-pill" :class="{ 'is-active': active(item.to) }" :aria-current="active(item.to) ? 'page' : undefined">
              {{ item.label }}
            </NuxtLink>
          </div>
        </nav>
        <NuxtLink to="/?new=1" class="btn btn-primary justify-self-end px-5 py-2.5 text-sm" data-test="new-proposal">New Proposal</NuxtLink>
      </header>
      <main>
        <NuxtPage />
      </main>
    </div>
  </UApp>
</template>
