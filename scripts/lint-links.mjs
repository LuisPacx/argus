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
const { parse, babelParse } = createRequire(join(root, 'apps/warroom/package.json'))('vue/compiler-sfc');

export const RULE = 'argus/no-raw-href';
const ELEMENT = 1;
const DIRECTIVE = 7;
// Attributes that navigate or submit to an address (compared lower-case). `:src` and NuxtLink `:to` are not covered yet.
const LINK_ATTRS = new Set(['href', 'xlink:href', 'formaction', 'action']);
// Elements whose bare `v-bind="..."` is always flagged: a spread can carry an href.
const LINK_TAGS = new Set(['a', 'UrlLink', 'NuxtLink']);

const parseExp = (text) => {
  try {
    return babelParse(`(${text})`, { plugins: ['typescript'], sourceType: 'module' }).program.body[0]?.expression ?? null;
  } catch {
    return null;
  }
};
const isSafeCall = (n) => n?.type === 'CallExpression' && n.callee.type === 'Identifier' && n.callee.name === 'safeHttpUrl';
/** Exactly `safeHttpUrl(<arg>)`, optionally `?? undefined`, and nothing else. */
const isSafeExp = (text) => {
  const n = parseExp(text);
  if (!n) return false;
  if (isSafeCall(n)) return true;
  return n.type === 'LogicalExpression' && n.operator === '??' && isSafeCall(n.left) && n.right.type === 'Identifier' && n.right.name === 'undefined';
};
/** An object literal with only plain keys, none of them link attributes: clearly free of href. */
const isPlainObject = (text) => {
  const n = parseExp(text);
  return n?.type === 'ObjectExpression' && n.properties.every((p) => {
    if (p.type !== 'ObjectProperty' || p.computed) return false;
    const key = p.key.type === 'Identifier' ? p.key.name : p.key.type === 'StringLiteral' ? p.key.value : null;
    return key !== null && !LINK_ATTRS.has(key.toLowerCase());
  });
};

/** The raw bound hrefs in one .vue file's template: [{ line, text }]. */
export function findRawHrefs(source, filename = 'file.vue') {
  const ast = parse(source, { filename }).descriptor.template?.ast;
  const found = [];
  const walk = (node) => {
    if (node.type === ELEMENT) {
      for (const p of node.props) {
        if (p.type !== DIRECTIVE || p.name !== 'bind') continue;
        const exp = p.exp?.loc.source.trim() ?? '';
        let bad;
        if (p.arg) bad = (!p.arg.isStatic || LINK_ATTRS.has(p.arg.content.toLowerCase())) && node.tag !== 'UrlLink' && !isSafeExp(exp);
        else bad = LINK_TAGS.has(node.tag) || !isPlainObject(exp);
        if (bad) found.push({ line: p.loc.start.line, text: p.loc.source });
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
