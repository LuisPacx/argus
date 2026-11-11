// Is `candidate` the live database (or its -wal/-shm sidecar)? Compares the resolved path, the realpath and device+inode,
// so a symlink or a hard link to a live file is caught as well as a plain path. `liveDbs` are paths; ones that do not exist are skipped.
import { realpathSync, statSync } from 'node:fs';
import path from 'node:path';

const SIDECARS = ['', '-wal', '-shm'];

function identity(p) {
  try {
    const s = statSync(p);
    return { real: realpathSync(p), key: `${s.dev}:${s.ino}` };
  } catch {
    return undefined;
  }
}

export function isLiveDb(candidate, liveDbs) {
  const resolved = path.resolve(candidate);
  if (/[\\/]\.data[\\/]argus\.db(-wal|-shm)?$/.test(resolved)) return true;
  const mine = identity(resolved);
  for (const live of liveDbs) {
    if (!live) continue;
    for (const suffix of SIDECARS) {
      const target = path.resolve(live + suffix);
      if (resolved === target) return true;
      const theirs = identity(target);
      if (mine && theirs && (mine.real === theirs.real || mine.key === theirs.key)) return true;
    }
  }
  return false;
}
