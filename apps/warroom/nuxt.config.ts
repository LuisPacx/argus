export default defineNuxtConfig({
  compatibilityDate: "2025-07-15",
  modules: ["@nuxt/ui"],
  typescript: { tsConfig: { compilerOptions: { erasableSyntaxOnly: true } } },
  css: ["~/assets/css/main.css"],
});
