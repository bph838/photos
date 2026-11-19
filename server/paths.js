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
export const PORT = Number(process.env.FAMILY_PHOTOS_PORT || 4321);

for (const d of [DATA_DIR, THUMB_DIR, CROP_DIR, MODEL_DIR]) fs.mkdirSync(d, { recursive: true });

// Thumbnails are sharded into sub-folders so no single folder holds 40k files.
export function thumbPath(id) {
  return path.join(THUMB_DIR, String(id % 256).padStart(3, '0'), `${id}.webp`);
}
export function cropPath(faceId) {
  return path.join(CROP_DIR, String(faceId % 256).padStart(3, '0'), `${faceId}.webp`);
}

export function log(...args) {
  const line = `[${new Date().toISOString()}] ${args.map((a) => (a instanceof Error ? a.stack : String(a))).join(' ')}\n`;
  process.stdout.write(line);
  try {
    fs.appendFileSync(LOG_PATH, line);
  } catch {}
}
