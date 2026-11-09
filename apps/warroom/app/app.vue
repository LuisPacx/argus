<script setup lang="ts">
const route = useRoute();
const NAV = [
  { to: "/", label: "Proposals" },
  { to: "/narratives", label: "Narratives" },
  { to: "/activity", label: "Activity" },
  { to: "/study", label: "Study" },
  { to: "/rubric", label: "Rubric" },
];
// Proposals stays lit on a Proposal's own page, Narratives on a Narrative's.
const active = (to: string) => (to === "/" ? route.path === "/" || route.path.startsWith("/proposals") : route.path.startsWith(to));
</script>

<template>
  <UApp>
    <div class="mx-auto w-full max-w-[1240px] px-5 pb-16 pt-8 sm:px-8 xl:px-0">
      <header class="mb-10 flex flex-wrap items-center justify-between gap-x-6 gap-y-4 lg:grid lg:grid-cols-[1fr_auto_1fr]">
        <NuxtLink to="/" class="text-lg font-bold tracking-tight">Argus War Room</NuxtLink>
        <nav class="order-last flex w-full gap-1 overflow-x-auto rounded-full bg-white p-1.5 shadow-[var(--wr-shadow)] lg:order-none lg:w-auto" aria-label="Main">
          <NuxtLink v-for="item in NAV" :key="item.to" :to="item.to" class="nav-pill" :class="{ 'is-active': active(item.to) }" :aria-current="active(item.to) ? 'page' : undefined">
            {{ item.label }}
          </NuxtLink>
        </nav>
        <NuxtLink to="/?new=1" class="btn btn-primary justify-self-end px-5 py-2.5 text-sm" data-test="new-proposal">New Proposal</NuxtLink>
      </header>
      <main>
        <NuxtPage />
      </main>
    </div>
  </UApp>
</template>
