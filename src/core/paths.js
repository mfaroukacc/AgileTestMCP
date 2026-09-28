import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Single source of truth for "where is the repo".
//
// Everything else in this project used to build paths from process.cwd(), which
// only works if the process happens to be started from the repo root. A CLI run
// from the terminal usually is, which is why the bug stayed invisible. An MCP
// client is different: it spawns the server with whatever directory the client
// itself is running in, frequently the user's home folder. Every relative path
// then silently resolves somewhere else - no error about directories, just
// "file not found" for files that clearly exist in the repo, and a .env that
// loads as empty so credentials come back undefined.
//
// Deriving the root from this module's own location is stable no matter who
// launches the process or from where.
const HERE = path.dirname(fileURLToPath(import.meta.url));

// src/core/ -> repo root
export const REPO_ROOT = path.resolve(HERE, '..', '..');

export const GENERATED_DIR = path.join(REPO_ROOT, 'Generated_Test_Cases');
export const RESULTS_DIR = path.join(REPO_ROOT, 'Execution_Results');
export const STATE_DIR = path.join(RESULTS_DIR, '.state');
export const ENV_FILE = path.join(REPO_ROOT, '.env');
