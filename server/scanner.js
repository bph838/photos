// Walks the chosen folders and keeps the photos table in step with the disk.
// Read-only with respect to the photos themselves.
import fs from 'node:fs';
import path from 'node:path';
import exifr from 'exifr';
import { IMAGE_EXTS } from './images.js';
import { thumbPath, cropPath, log } from './paths.js';
import { tx } from './db.js';
import { detachFromCluster } from './cluster.js';

const SKIP_DIRS = new Set(['$recycle.bin', 'system volume information', 'node_modules', '.git', '@eadir', '.thumbnails', 'appdata']);
const MIN_BYTES = 15 * 1024; // ignore icons and tiny images

async function* walk(dir) {
  let entries;
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch (e) {
    log('Cannot read folder', dir, e.code || e.message);
    return;
  }
  for (const ent of entries) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (ent.name.startsWith('.') || SKIP_DIRS.has(ent.name.toLowerCase())) continue;
      yield* walk(full);
    } else if (ent.isFile() && IMAGE_EXTS.has(path.extname(ent.name).toLowerCase())) {
      yield full;
    }
  }
}

async function readExif(file) {
  try {
    const x = await exifr.parse(file, {
      pick: ['DateTimeOriginal', 'CreateDate', 'DateTimeDigitized', 'Make', 'Model'],
      reviveValues: true,
    });
    if (!x) return {};
    const d = x.DateTimeOriginal || x.CreateDate || x.DateTimeDigitized;
    const taken = d instanceof Date && !isNaN(d) && d.getFullYear() > 1900 ? d.getTime() : null;
    const camera = [x.Make, x.Model].filter(Boolean).join(' ').trim() || null;
    return { taken, camera };
  } catch {
    return {};
  }
}

function forgetDerived(db, id) {
  for (const f of db.prepare('SELECT id, cluster_id, emb FROM faces WHERE photo_id = ?').all(id)) {
    detachFromCluster(db, f);
    fs.rmSync(cropPath(f.id), { force: true });
  }
  db.prepare('DELETE FROM faces WHERE photo_id = ?').run(id);
  fs.rmSync(thumbPath(id), { force: true });
}

/**
 * Scan every library folder. Calls onProgress({ found }) occasionally.
 * Returns { added, changed, missing }.
 */
export async function scanLibrary(db, onProgress = () => {}) {
  const roots = db.prepare('SELECT path FROM folders').all().map((r) => r.path);
  const known = new Map();
  for (const r of db.prepare('SELECT id, path, size, mtime, missing FROM photos').all()) known.set(r.path, r);

  const seen = new Set();
  const reachableRoots = [];
  let added = 0;
  let changed = 0;
  let found = 0;
  const insert = db.prepare(
    `INSERT INTO photos (path, folder, filename, size, mtime, taken, camera, added) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const update = db.prepare(
    `UPDATE photos SET size = ?, mtime = ?, taken = ?, camera = ?, missing = 0, ai_state = 0, clip = NULL, thumb = 0, width = NULL, height = NULL WHERE id = ?`
  );
  const unmiss = db.prepare('UPDATE photos SET missing = 0 WHERE id = ?');

  let batch = [];
  const flush = () => {
    if (!batch.length) return;
    const work = batch;
    batch = [];
    tx(db, () => work.forEach((fn) => fn()));
  };

  for (const root of roots) {
    if (!fs.existsSync(root)) {
      log('Library folder not available (unplugged drive?):', root);
      continue;
    }
    reachableRoots.push(root);
    for await (const file of walk(root)) {
      let st;
      try {
        st = await fs.promises.stat(file);
      } catch {
        continue;
      }
      if (st.size < MIN_BYTES) continue;
      seen.add(file);
      found++;
      if (found % 500 === 0) onProgress({ found });
      const prev = known.get(file);
      const mtime = Math.round(st.mtimeMs);
      if (prev && prev.size === st.size && prev.mtime === mtime) {
        if (prev.missing) batch.push(() => unmiss.run(prev.id));
      } else {
        const { taken, camera } = await readExif(file);
        const when = taken ?? mtime;
        if (prev) {
          changed++;
          batch.push(() => {
            forgetDerived(db, prev.id);
            update.run(st.size, mtime, when, camera ?? null, prev.id);
          });
        } else {
          added++;
          batch.push(() =>
            insert.run(file, path.dirname(file), path.basename(file), st.size, mtime, when, camera ?? null, Date.now())
          );
        }
      }
      if (batch.length >= 200) flush();
    }
  }
  flush();

  // Photos we didn't see are marked missing (kept, so tags survive a drive being unplugged
  // or a folder being temporarily renamed). Only for folders we could actually read.
  let missing = 0;
  const markMissing = db.prepare('UPDATE photos SET missing = 1 WHERE id = ?');
  const inRoot = (p) => reachableRoots.some((r) => p.toLowerCase().startsWith(r.toLowerCase().replace(/[\\/]?$/, path.sep)));
  const inAnyRoot = (p) => roots.some((r) => p.toLowerCase().startsWith(r.toLowerCase().replace(/[\\/]?$/, path.sep)));
  tx(db, () => {
    for (const [p, r] of known) {
      if (r.missing || seen.has(p)) continue;
      if (inRoot(p) || !inAnyRoot(p)) {
        markMissing.run(r.id);
        missing++;
      }
    }
  });
  onProgress({ found });
  return { added, changed, missing };
}
