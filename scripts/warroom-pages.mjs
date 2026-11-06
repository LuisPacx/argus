// Helpers for verify:boot's War Room step: which page routes exist, and whether one answered healthily.
import fs from 'node:fs';
import path from 'node:path';

// Every .vue file under app/pages as a route, with `[id]` filled from `ids` ({ narratives: 3, proposals: 5 }, keyed by the
// route's first segment). A dynamic page with no id for its section is returned as-is so the caller notices.
export function pageRoutes(pagesDir, ids) {
  const routes = [];
  const walk = (dir, prefix) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        walk(path.join(dir, entry.name), `${prefix}/${entry.name}`);
        continue;
      }
      if (!entry.name.endsWith('.vue')) continue;
      const name = entry.name.slice(0, -'.vue'.length);
      routes.push(name === 'index' ? prefix || '/' : `${prefix}/${name}`);
    }
  };
  walk(pagesDir, '');
  return routes
    .map((route) => route.replace(/\[(\w+)\]/g, (whole) => String(ids[route.split('/')[1]] ?? whole)))
    .sort();
}

// A page is healthy when it answers 2xx and the body is not Nuxt's error page / payload.
// Returns a problem string, or null when healthy.
export function pageProblem(status, body) {
  if (status < 200 || status > 299) {
    const message = /"message":"([^"]+)"/.exec(body)?.[1] ?? /\[nuxt\][^\n<]*/.exec(body)?.[0];
    return `status ${status}${message ? ` (${message})` : ''}`;
  }
  if (/"statusCode":\s*[45]\d\d/.test(body) || body.includes('id="__nuxt_error"') || body.includes('nuxt-error-page')) {
    return `status ${status} but the body is a Nuxt error payload`;
  }
  return null;
}
