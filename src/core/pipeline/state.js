import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { STATE_DIR } from '../paths.js';

function ensureStateDir() {
  if (!fs.existsSync(STATE_DIR)) fs.mkdirSync(STATE_DIR, { recursive: true });
  return STATE_DIR;
}

function lockPath(storyKey) {
  return path.join(ensureStateDir(), `${storyKey}.lock.json`);
}

function manifestPath(storyKey) {
  return path.join(ensureStateDir(), `${storyKey}.manifest.json`);
}

function isPidAlive(pid) {
  if (!pid || typeof pid !== 'number') return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === 'EPERM';
  }
}

// A run that outlives this window is presumed dead unless its heartbeat is fresh.
const LOCK_STALE_MS = 15 * 60 * 1000;

// Remove a lock file, tolerating a concurrent remover or a missing file.
function safeUnlink(file) {
  try {
    fs.unlinkSync(file);
  } catch (err) {
    if (err?.code !== 'ENOENT') {
      console.log(`[lock] Could not remove ${file}: ${err?.message || err}`);
    }
  }
}

// Prevents two pipeline runs for the same story from overlapping. This is the
// guard that stops duplicate test cases: without it a second run can start
// while the first is still creating issues, see an incomplete picture of what
// exists, and create duplicates.
//
// Note: the lock lives in the local working directory, so it only serialises
// runs that share a checkout. Summary-based reuse in the Jira phase is what
// actually prevents duplicates across separate checkouts, and the re-check
// before each create narrows the window where two runs could both miss.
//
// The `force` override was removed from the MCP tools. A crashed run is handled
// by the heartbeat expiry below instead, so there is no way to defeat the guard
// through the tool surface.
export function acquireLock(storyKey) {
  const file = lockPath(storyKey);

  if (fs.existsSync(file)) {
    let current = null;
    try {
      current = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      current = null;
    }

    if (current && isPidAlive(current.pid) && current.pid !== process.pid) {
      const err = new Error(
        `A pipeline run for ${storyKey} is already in progress ` +
          `(pid ${current.pid}, started ${current.startedAt}). ` +
          `Refusing to start a second concurrent run, because overlapping runs create duplicate ` +
          `test cases. Wait for it to finish, then retry.`,
      );
      err.code = 'ELOCKED';
      throw err;
    }

    if (current && current.pid === process.pid) {
      // Re-entrant call within the same process (e.g. phase scripts run
      // standalone after a full run). Safe to take over.
      console.log('[lock] Re-entrant lock request from the same process.');
      safeUnlink(file);
    } else if (current && !isPidAlive(current.pid)) {
      // The lock file must actually be removed here. The exclusive "wx" create
      // below fails with EEXIST while the file exists, so a crashed run would
      // otherwise block the story forever.
      console.log(`[lock] Clearing stale lock from dead pid ${current.pid}.`);
      safeUnlink(file);
    }
  }

  const payload = {
    pid: process.pid,
    storyKey,
    startedAt: new Date().toISOString(),
    heartbeatAt: new Date().toISOString(),
  };

  // "wx" fails if the file already exists, so two processes racing to start
  // cannot both win. The loser sees ELOCKED instead of creating duplicates.
  try {
    fs.writeFileSync(file, JSON.stringify(payload, null, 2), { encoding: 'utf8', flag: 'wx' });
  } catch (err) {
    if (err?.code === 'EEXIST') {
      const conflict = new Error(
        `Another pipeline run for ${storyKey} started at the same moment. ` +
          `Refusing to run concurrently, because overlapping runs create duplicate test cases.`,
      );
      conflict.code = 'ELOCKED';
      throw conflict;
    }
    throw err;
  }

  // Refresh the lock periodically so a long run is never mistaken for a dead
  // one by a peer sharing this checkout.
  const timer = setInterval(() => {
    try {
      const current = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (current.pid !== process.pid) return;
      current.heartbeatAt = new Date().toISOString();
      fs.writeFileSync(file, JSON.stringify(current, null, 2), 'utf8');
    } catch {
      /* best effort */
    }
  }, 60 * 1000);
  timer.unref?.();

  return file;
}

export function releaseLock(storyKey) {
  const file = lockPath(storyKey);
  if (!fs.existsSync(file)) return;
  try {
    const current = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (current.pid === process.pid) fs.unlinkSync(file);
  } catch {
    /* best effort */
  }
}

// True when a lock exists and looks actively held. Used to report why a story
// is busy rather than silently waiting.
export function inspectLock(storyKey) {
  const file = lockPath(storyKey);
  if (!fs.existsSync(file)) return null;
  try {
    const current = JSON.parse(fs.readFileSync(file, 'utf8'));
    const age = Date.now() - Date.parse(current.heartbeatAt || current.startedAt || 0);
    return { ...current, ageMs: Number.isNaN(age) ? null : age, stale: age > LOCK_STALE_MS };
  } catch {
    return null;
  }
}

export function fingerprintFile(filePath) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(filePath));
  return `sha256:${hash.digest('hex').slice(0, 16)}`;
}

export function loadManifest(storyKey) {
  const file = manifestPath(storyKey);
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

export function saveManifest(storyKey, data) {
  ensureStateDir();
  const file = manifestPath(storyKey);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, file);
  return file;
}

export function clearManifest(storyKey) {
  const file = manifestPath(storyKey);
  if (fs.existsSync(file)) fs.unlinkSync(file);
}

export function getStateDir() {
  return ensureStateDir();
}
