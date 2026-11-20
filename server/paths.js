// Where the app keeps its own data. The user's photos are never written to:
// everything we create (database, thumbnails, models, logs) lives here.
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const base =
  process.env.FAMILY_PHOTOS_DATA ||
  path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), '.local', 'share'), 'FamilyPhotos');

export const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DATA_DIR = base;
export const DB_PATH = path.join(base, 'library.db');
export const THUMB_DIR = path.join(base, 'thumbs');
export const CROP_DIR = path.join(base, 'crops');
export const MODEL_DIR = path.join(base, 'models');
export const LOG_PATH = path.join(base, 'log.txt');
// Photos that froze or crashed the indexer while being read; their dates come from the file instead.
export const SKIP_PATH = path.join(base, 'skip-files.json');
export const PORT = Number(process.env.FAMILY_PHOTOS_PORT || 4321);

for (const d of [DATA_DIR, THUMB_DIR, CROP_DIR, MODEL_DIR]) fs.mkdirSync(d, { recursive: true });

// Thumbnails are sharded into sub-folders so no single folder holds 40k files.
export function thumbPath(id) {
  return path.join(THUMB_DIR, String(id % 256).padStart(3, '0'), `${id}.webp`);
}
export function cropPath(faceId) {
  return path.join(CROP_DIR, String(faceId % 256).padStart(3, '0'), `${faceId}.webp`);
}

// Lines from the background indexer are marked so the two processes can be told apart.
const WHO = process.send ? ' [background]' : '';
const LOG_MAX = 5 * 1024 * 1024;
let logChecked = 0;

export function log(...args) {
  const line = `[${new Date().toISOString()}]${WHO} ${args.map((a) => (a instanceof Error ? a.stack : String(a))).join(' ')}\n`;
  process.stdout.write(line);
  try {
    // Keep the log a sensible size to share: start a new one past 5 MB (the previous is kept).
    if (Date.now() - logChecked > 60000) {
      logChecked = Date.now();
      if (fs.statSync(LOG_PATH, { throwIfNoEntry: false })?.size > LOG_MAX) {
        fs.renameSync(LOG_PATH, path.join(base, 'log-previous.txt'));
      }
    }
    fs.appendFileSync(LOG_PATH, line);
  } catch {}
}

/** The last `lines` lines of the log. */
export function logTail(lines = 40) {
  try {
    const fd = fs.openSync(LOG_PATH, 'r');
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, 256 * 1024);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    fs.closeSync(fd);
    return buf.toString('utf8').split('\n').map((l) => l.trimEnd()).filter(Boolean).slice(-lines);
  } catch {
    return [];
  }
}

/** Files the scanner should not open (see SKIP_PATH). */
export function readSkipList() {
  try {
    return new Set(JSON.parse(fs.readFileSync(SKIP_PATH, 'utf8')));
  } catch {
    return new Set();
  }
}
export function addToSkipList(file) {
  const s = readSkipList();
  if (s.has(file)) return;
  s.add(file);
  try {
    fs.writeFileSync(SKIP_PATH, JSON.stringify([...s], null, 1));
  } catch {}
}
