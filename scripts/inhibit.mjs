// Sleep/lid-switch lock for the long-lived dev processes (see dev-server.mjs).
// `systemd-inhibit` stays the parent of the wrapped command and exits with it, so the
// lock lives exactly as long as the process does, including after a crash or SIGKILL.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';

export const INHIBIT_WHAT = 'handle-lid-switch:sleep';
export const INHIBIT_WHO = 'argus';
export const MISSING_WARNING = 'warning: systemd-inhibit not found on PATH; starting without a lock, so closing the lid or sleeping WILL suspend argus';

export function inhibitPrefix(why) {
  return ['--what=' + INHIBIT_WHAT, '--who=' + INHIBIT_WHO, '--why=' + why, '--mode=block'];
}

function executable(file) {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function onPath(bin = 'systemd-inhibit', pathVar = process.env.PATH ?? '', isExecutable = executable) {
  return pathVar.split(':').filter(Boolean).some((dir) => isExecutable(`${dir}/${bin}`));
}

// Returns { command, args, warning }. Without systemd-inhibit the command runs unwrapped.
export function wrapCommand(command, args, why, available) {
  if (!available) return { command, args, warning: MISSING_WARNING };
  return { command: 'systemd-inhibit', args: [...inhibitPrefix(why), command, ...args], warning: null };
}

// Count argus locks in `systemd-inhibit --list` output (columns: WHO UID USER PID COMM WHAT WHY MODE).
export function countLocks(listOutput) {
  return listOutput.split('\n').filter((l) => /^argus\s/.test(l) && l.includes('handle-lid-switch') && /\bsleep\b/.test(l)).length; // systemd lists WHAT in its own order
}

export function lockStatusLine(available, listOutput) {
  if (!available) return 'sleep lock: unavailable (systemd-inhibit not on PATH)';
  if (listOutput === null) return 'sleep lock: unknown (systemd-inhibit --list failed)';
  const n = countLocks(listOutput);
  return n > 0 ? `sleep lock: held (${n} argus lock${n > 1 ? 's' : ''}, ${INHIBIT_WHAT})` : 'sleep lock: not held';
}

export function listLocks() {
  const r = spawnSync('systemd-inhibit', ['--list', '--no-pager'], { encoding: 'utf8' });
  return r.error || r.status !== 0 ? null : r.stdout;
}
