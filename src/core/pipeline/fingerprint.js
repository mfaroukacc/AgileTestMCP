import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { REPO_ROOT } from '../paths.js';

// Guard against running stale code.
//
// A long-lived MCP server imports this module graph once, at start-up, and keeps
// those modules in memory for its whole lifetime. Any edit to src/core or mcp
// made after that point is invisible to the running process, so safety fixes and
// bug fixes silently do not apply. A pipeline run then performs real creates,
// updates and deletes using code that no longer exists on disk.
//
// That failure is invisible: the run succeeds, reports plausible numbers, and
// the file on disk says something different from what actually executed. So we
// hash the sources at module load (that is the code which is running) and
// re-hash them on every guarded call. If the two disagree, the running code is
// stale and destructive work is refused.
//
// Reads only. Never mutates, never calls the network.

// REPO_ROOT comes from ../paths.js so the repo location is defined in one place
// and never derived from the launch directory.
const WATCH_DIRS = ['src/core', 'mcp'];
const WATCH_EXT = '.js';

function sha256(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

function collectJsFiles(dir) {
  const found = [];
  const walk = (current) => {
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
        walk(full);
      } else if (entry.isFile() && entry.name.endsWith(WATCH_EXT)) {
        found.push(path.relative(REPO_ROOT, full).split(path.sep).join('/'));
      }
    }
  };
  walk(dir);
  return found.sort();
}

function hashSources() {
  const perFile = new Map();
  for (const rel of WATCH_DIRS.flatMap((d) => collectJsFiles(path.join(REPO_ROOT, d)))) {
    let content;
    try {
      content = fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
    } catch {
      perFile.set(rel, null);
      continue;
    }
    perFile.set(rel, sha256(content));
  }
  const overall = sha256([...perFile.entries()].map(([f, h]) => `${f}:${h}`).join('\n'));
  return { hash: overall, perFile };
}

// Captured when this module is first imported, i.e. when the server started.
const LOADED = hashSources();

function short(hash) {
  return typeof hash === 'string' ? hash.slice(0, 12) : String(hash);
}

export function getBuildInfo() {
  return {
    hash: short(LOADED.hash),
    watchedDirs: WATCH_DIRS,
    fileCount: LOADED.perFile.size,
    repoRoot: REPO_ROOT,
  };
}

// Compare the running code against what is on disk right now.
export function checkStaleCode() {
  const current = hashSources();
  if (current.hash === LOADED.hash) {
    return { stale: false, buildHash: short(LOADED.hash) };
  }

  const changed = [];
  const added = [];
  const removed = [];
  for (const [file, hash] of current.perFile) {
    if (!LOADED.perFile.has(file)) {
      added.push(file);
    } else if (LOADED.perFile.get(file) !== hash) {
      changed.push(file);
    }
  }
  for (const file of LOADED.perFile.keys()) {
    if (!current.perFile.has(file)) removed.push(file);
  }

  return {
    stale: true,
    buildHash: short(LOADED.hash),
    diskHash: short(current.hash),
    changed,
    added,
    removed,
  };
}

// Refuse destructive work when the running code is not the code on disk.
export function assertFreshCode({ bypassEnvVar = 'AGILETEST_ALLOW_STALE_CODE', context = '' } = {}) {
  const status = checkStaleCode();
  if (!status.stale) return status;

  const where = context ? ` before ${context}` : '';
  const detail = [
    status.changed.length ? `changed: ${status.changed.join(', ')}` : null,
    status.added.length ? `added: ${status.added.join(', ')}` : null,
    status.removed.length ? `removed: ${status.removed.join(', ')}` : null,
  ]
    .filter(Boolean)
    .join('; ');

  if (process.env[bypassEnvVar] === '1') {
    const err = new Error(
      `STALE CODE BYPASSED${where}. This process is running build ${status.buildHash} ` +
        `but disk is ${status.diskHash} (${detail}). It will keep executing old logic. ` +
        `Restart the MCP server instead of using this override.`,
    );
    err.code = 'ESTALECODEBYPASSED';
    err.stale = status;
    console.error(`[stale-code] WARNING ${err.message}`);
    return status;
  }

  const err = new Error(
    `Refusing to run${where}: this server is running stale code. ` +
      `Running build ${status.buildHash}, disk is ${status.diskHash} (${detail}). ` +
      `Restart the MCP server so it loads the current code, then retry. ` +
      `Set ${bypassEnvVar}=1 only if you deliberately want the old behaviour.`,
  );
  err.code = 'ESTALECODE';
  err.stale = status;
  throw err;
}
