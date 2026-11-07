export default defineNuxtConfig({
  compatibilityDate: "2025-07-15",
  modules: ["@nuxt/ui"],
  typescript: { tsConfig: { compilerOptions: { erasableSyntaxOnly: true } } },
  css: ["~/assets/css/main.css"],
  // The Soft Rows design is light only.
  colorMode: { preference: "light", fallback: "light" },
  // List <-> detail navigation: a short CSS fade (see .page-* in main.css). Nuxt's built-in page transition, no library.
  app: { pageTransition: { name: "page", mode: "out-in" } },
});
