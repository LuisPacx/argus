// Is an X auth cookie row in the Chrome profile's cookie store? Only the row's existence is read (the values are encrypted and never
// selected). Opened read-only: Chrome is not started and the profile's SingletonLock is not touched. true / false, or null for cannot tell.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export function cookieState(dir) {
  const files = [path.join(dir, 'Default', 'Network', 'Cookies'), path.join(dir, 'Default', 'Cookies')].filter((f) => fs.existsSync(f));
  for (const file of files) {
    let db;
    try {
      db = new DatabaseSync(file, { readOnly: true });
      const row = db.prepare("SELECT 1 AS found FROM cookies WHERE name = 'auth_token' AND host_key IN ('.x.com', 'x.com', '.twitter.com') LIMIT 1").get();
      return row !== undefined;
    } catch {
      // Locked or unreadable: try the next file, then say cannot tell.
    } finally {
      try {
        db?.close();
      } catch {
        // Nothing to close.
      }
    }
  }
  return null;
}
