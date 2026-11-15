// May the replay script use `work` as its throwaway directory? It writes there and used to delete whatever it found first, so a
// mistyped `--work ~` or `--work .` could have wiped a real directory. Now the directory must be strictly under one of the allowed roots
// (the home disk cache and the session temp dir, never /tmp itself) and must not exist yet or be empty. Returns the reason it is refused, or undefined.
import { existsSync, readdirSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';

export function workDirRefusal(work, roots) {
  const resolved = path.resolve(work);
  const real = existsSync(resolved) ? realpathSync(resolved) : resolved;
  const under = (child, parent) => child !== parent && child.startsWith(parent + path.sep);
  const allowed = roots.filter((r) => r && r !== '/tmp' && r !== path.sep).map((r) => path.resolve(r));
  const inside = (p) => allowed.some((r) => under(p, r) || (existsSync(r) && under(p, realpathSync(r))));
  if (resolved === '/tmp' || resolved.startsWith('/tmp/')) return 'the work directory must not be under /tmp';
  if (!inside(resolved) || !inside(real)) return `the work directory must be a new directory under ${allowed.join(' or ')}`;
  if (existsSync(resolved)) {
    if (!statSync(resolved).isDirectory()) return 'the work path exists and is not a directory';
    if (readdirSync(resolved).length > 0) return 'the work directory is not empty; delete it yourself first (the script never deletes anything)';
  }
  return undefined;
}
