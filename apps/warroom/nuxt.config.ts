// `pnpm page:check --seed` runs a private dev server beside the live one: ARGUS_NUXT_BUILD_DIR moves its build output (and the Vite
// cache) into its throwaway dir, so it never rewrites the live War Room's .nuxt/ or node_modules/.cache/vite. Unset in normal use.
const privateBuildDir = process.env.ARGUS_NUXT_BUILD_DIR;

export default defineNuxtConfig({
  ...(privateBuildDir ? { buildDir: `${privateBuildDir}/.nuxt`, vite: { cacheDir: `${privateBuildDir}/vite-cache` } } : {}),
  compatibilityDate: "2025-07-15",
  modules: ["@nuxt/ui"],
  typescript: { tsConfig: { compilerOptions: { erasableSyntaxOnly: true } } },
  css: ["~/assets/css/main.css"],
  // The Soft Rows design is light only.
  colorMode: { preference: "light", fallback: "light" },
  // List <-> detail navigation: a short CSS fade (see .page-* in main.css). Nuxt's built-in page transition, no library.
  app: { pageTransition: { name: "page", mode: "out-in" } },
});
