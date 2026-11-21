// `argus/no-raw-href` (War Room ticket 02), run by `pnpm lint` after oxlint. oxlint only lints a .vue file's <script>, never its template, so this
// is a small template scanner instead of a plugin rule. It fails a bound href (`:href`, `v-bind:href`, `v-bind="{ href }"`, a dynamic `:[name]`)
// in an apps/warroom .vue template unless the bound expression is a call to `safeHttpUrl` (optionally `?? undefined`) or the element is the
// UrlLink component, which validates `href` itself. Static `href="https://..."` is fine. There is no disable comment: route the link through
// `safeHttpUrl` or UrlLink. See docs/agents/worker-rules.md.
import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
// vue is a dependency of apps/warroom only, so resolve it from there.
const { parse } = createRequire(join(root, 'apps/warroom/package.json'))('vue/compiler-sfc');

export const RULE = 'argus/no-raw-href';
const ELEMENT = 1;
const DIRECTIVE = 7;
const SAFE_CALL = /^safeHttpUrl\([^]*\)( \?\? undefined)?$/;

/** The raw bound hrefs in one .vue file's template: [{ line, text }]. */
export function findRawHrefs(source, filename = 'file.vue') {
  const ast = parse(source, { filename }).descriptor.template?.ast;
  const found = [];
  const walk = (node) => {
    if (node.type === ELEMENT && node.tag !== 'UrlLink') {
      for (const p of node.props) {
        if (p.type !== DIRECTIVE || p.name !== 'bind') continue;
        const exp = p.exp?.loc.source.trim() ?? '';
        const named = p.arg ? !p.arg.isStatic || p.arg.content === 'href' : /\bhref\b/.test(exp);
        if (named && !SAFE_CALL.test(exp)) found.push({ line: p.loc.start.line, text: p.loc.source });
      }
    }
    for (const c of node.children ?? []) if (typeof c === 'object') walk(c);
  };
  if (ast) walk(ast);
  return found;
}

function vueFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    if (e.name === 'node_modules' || e.name.startsWith('.')) return [];
    const p = join(dir, e.name);
    return e.isDirectory() ? vueFiles(p) : e.name.endsWith('.vue') ? [p] : [];
  });
}

/** Every violation under apps/warroom as `path:line: text`. */
export function scanWarroom() {
  return vueFiles(join(root, 'apps/warroom')).flatMap((f) =>
    findRawHrefs(readFileSync(f, 'utf8'), f).map((v) => `${relative(root, f)}:${v.line}: ${v.text}`),
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const bad = scanWarroom();
  for (const b of bad) console.error(`${RULE}: ${b}\n  A link from stored or fetched data must go through safeHttpUrl (apps/warroom/app/utils/safe-link.ts) or UrlLink. See docs/agents/worker-rules.md.`);
  if (bad.length > 0) process.exit(1);
  console.log(`${RULE}: ok`);
}
