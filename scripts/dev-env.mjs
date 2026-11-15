// ARGUS_* settings from the repo-root .env for the dev processes (`pnpm dev:start`).
// Same parser as packages/core (node:util parseEnv). Only ^ARGUS_[A-Z0-9_]+$ keys pass; a variable
// already set in the shell environment wins over .env. A missing .env is a no-op.
import fs from 'node:fs';
import { parseEnv } from 'node:util';

const KEY = /^ARGUS_[A-Z0-9_]+$/;

// Returns { env, fromFile, overridden }: env is the shell env plus the .env ARGUS_* keys the
// shell did not set; fromFile and overridden list keys only.
export function withDotenvArgus(shellEnv, envFile) {
  const out = { env: { ...shellEnv }, fromFile: [], overridden: [] };
  if (!fs.existsSync(envFile)) return out;
  const parsed = parseEnv(fs.readFileSync(envFile, 'utf8'));
  for (const [key, value] of Object.entries(parsed)) {
    if (!KEY.test(key)) continue;
    if (shellEnv[key] !== undefined) out.overridden.push(key);
    else {
      out.env[key] = value;
      out.fromFile.push(key);
    }
  }
  return out;
}

export function dotenvLine(r) {
  const list = (keys) => (keys.length ? ` (${keys.join(', ')})` : '');
  return `env: ${r.fromFile.length} ARGUS_* from .env${list(r.fromFile)}; ${r.overridden.length} overridden by the shell${list(r.overridden)}`;
}
