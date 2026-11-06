<template>
  <UApp>
    <main class="mx-auto max-w-5xl p-8">
      <NuxtLink to="/"><h1 class="mb-6 text-2xl font-semibold">Argus War Room</h1></NuxtLink>
      <nav class="mb-4 flex gap-4 text-sm">
        <NuxtLink to="/narratives">Narratives</NuxtLink>
        <NuxtLink to="/rubric">Rubric</NuxtLink>
      </nav>
      <NuxtPage />
    </main>
  </UApp>
</template>
