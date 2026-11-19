import { DatabaseSync } from 'node:sqlite';
import { DB_PATH } from './paths.js';

export function openDb() {
  const db = new DatabaseSync(DB_PATH);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA busy_timeout = 10000;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS folders (
      id INTEGER PRIMARY KEY,
      path TEXT NOT NULL UNIQUE
    );

    CREATE TABLE IF NOT EXISTS photos (
      id INTEGER PRIMARY KEY,
      path TEXT NOT NULL UNIQUE,
      folder TEXT NOT NULL,
      filename TEXT NOT NULL,
      size INTEGER,
      mtime INTEGER,
      taken INTEGER,              -- ms since epoch (EXIF date, else file date)
      width INTEGER,
      height INTEGER,
      camera TEXT,
      favorite INTEGER NOT NULL DEFAULT 0,
      thumb INTEGER NOT NULL DEFAULT 0,      -- 1 once a thumbnail exists, -1 if unreadable
      missing INTEGER NOT NULL DEFAULT 0,
      ai_state INTEGER NOT NULL DEFAULT 0,   -- 0 todo, 1 done, -1 failed
      clip BLOB,                              -- 512 float32 image embedding
      added INTEGER
    );
    CREATE INDEX IF NOT EXISTS photos_taken ON photos(missing, taken DESC, id DESC);
    CREATE INDEX IF NOT EXISTS photos_ai ON photos(ai_state);
    CREATE INDEX IF NOT EXISTS photos_thumb ON photos(thumb);

    CREATE TABLE IF NOT EXISTS persons (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'person',   -- 'person' | 'pet'
      cover_face_id INTEGER,
      created INTEGER
    );

    CREATE TABLE IF NOT EXISTS clusters (
      id INTEGER PRIMARY KEY,
      kind TEXT NOT NULL,                     -- 'face' | 'pet'
      person_id INTEGER REFERENCES persons(id) ON DELETE SET NULL,
      vsum BLOB NOT NULL,                     -- running sum of embeddings
      count INTEGER NOT NULL,
      ignored INTEGER NOT NULL DEFAULT 0
    );

    -- A "face" row is any detected subject: a human face or a pet.
    CREATE TABLE IF NOT EXISTS faces (
      id INTEGER PRIMARY KEY,
      photo_id INTEGER NOT NULL REFERENCES photos(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,                     -- 'face' | 'pet'
      label TEXT,                             -- for pets: 'dog' | 'cat'
      x REAL, y REAL, w REAL, h REAL,         -- box as fractions of the image
      score REAL,
      emb BLOB,
      cluster_id INTEGER REFERENCES clusters(id) ON DELETE SET NULL,
      person_id INTEGER REFERENCES persons(id) ON DELETE SET NULL,
      confirmed INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS faces_photo ON faces(photo_id);
    CREATE INDEX IF NOT EXISTS faces_person ON faces(person_id);
    CREATE INDEX IF NOT EXISTS faces_cluster ON faces(cluster_id);

    -- "This is not X": stops a face being suggested for that person again.
    CREATE TABLE IF NOT EXISTS rejections (
      face_id INTEGER NOT NULL REFERENCES faces(id) ON DELETE CASCADE,
      person_id INTEGER NOT NULL REFERENCES persons(id) ON DELETE CASCADE,
      PRIMARY KEY (face_id, person_id)
    );

    -- 'This group is not X': stops a whole group being suggested again.
    CREATE TABLE IF NOT EXISTS cluster_rejections (
      cluster_id INTEGER NOT NULL REFERENCES clusters(id) ON DELETE CASCADE,
      person_id INTEGER NOT NULL REFERENCES persons(id) ON DELETE CASCADE,
      PRIMARY KEY (cluster_id, person_id)
    );

    CREATE TABLE IF NOT EXISTS print_list (
      photo_id INTEGER PRIMARY KEY REFERENCES photos(id) ON DELETE CASCADE,
      added INTEGER
    );

    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
  `);
  migrate(db);
  return db;
}

// Columns added after the first release. Each runs once on an older library.
function migrate(db) {
  const cols = new Set(db.prepare('PRAGMA table_info(photos)').all().map((c) => c.name));
  if (!cols.has('cloud')) {
    // 1 = only in OneDrive/iCloud (not downloaded): we must not read the file.
    db.exec('ALTER TABLE photos ADD COLUMN cloud INTEGER NOT NULL DEFAULT 0');
  }
}

export function toBlob(f32) {
  return new Uint8Array(f32.buffer, f32.byteOffset, f32.byteLength);
}
export function fromBlob(blob) {
  if (!blob) return null;
  // Copy so the Float32Array is correctly aligned.
  const copy = new Uint8Array(blob.byteLength);
  copy.set(blob);
  return new Float32Array(copy.buffer);
}

export function getSetting(db, key, fallback = null) {
  const r = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return r ? JSON.parse(r.value) : fallback;
}
export function setSetting(db, key, value) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(
    key,
    JSON.stringify(value)
  );
}

export function tx(db, fn) {
  db.exec('BEGIN');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}
