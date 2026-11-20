// Walks the chosen folders and keeps the photos table in step with the disk.
// Read-only with respect to the photos themselves.
import fs from 'node:fs';
import path from 'node:path';
import exifr from 'exifr';
import { IMAGE_EXTS } from './images.js';
import { thumbPath, cropPath, log } from './paths.js';
import { tx } from './db.js';
import { detachFromCluster } from './cluster.js';
import { isCloudOnly } from './win/shell.js';

const SKIP_DIRS = new Set(['$recycle.bin', 'system volume information', 'node_modules', '.git', '@eadir', '.thumbnails', 'appdata']);
const MIN_BYTES = 15 * 1024; // ignore icons and tiny images

// Files we don't mention when explaining what was skipped (Windows/camera clutter).
const BORING = /^\.(ini|db|lnk|tmp|json|xml|txt|aae|xmp|thm|dat|log|url)$/;

/**
 * Yields every photo file under dir. `stats` collects what was seen so the app can explain
 * what it is doing, and why something might not show up (folders it couldn't open, files
 * that aren't photos...). `visited` stops linked folders from looping forever.
 */
async function* walk(dir, stats, visited = new Set()) {
  try {
    const real = (await fs.promises.realpath(dir)).toLowerCase();
    if (visited.has(real)) return;
    visited.add(real);
  } catch {}
  stats.folders++;
  stats.current = dir;
  stats.tick?.();
  let entries;
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch (e) {
    log('Cannot read folder', dir, e.code || e.message);
    stats.unreadable.push({ path: dir, why: e.code || e.message });
    return;
  }
  for (const ent of entries) {
    const full = path.join(dir, ent.name);
    let isDir = ent.isDirectory();
    let isFile = ent.isFile();
    // Windows reports OneDrive/iCloud placeholders and junction folders as links ("reparse
    // points"). Ask what they really are; stat doesn't download cloud files.
    if (!isDir && !isFile) {
      try {
        const st = await fs.promises.stat(full);
        isDir = st.isDirectory();
        isFile = st.isFile();
      } catch {
        continue;
      }
    }
    if (isDir) {
      if (ent.name.startsWith('.') || SKIP_DIRS.has(ent.name.toLowerCase())) continue;
      yield* walk(full, stats, visited);
    } else if (isFile) {
      stats.files++;
      const ext = path.extname(ent.name).toLowerCase();
      if (IMAGE_EXTS.has(ext)) yield full;
      else if (!BORING.test(ext) && !ent.name.startsWith('~')) {
        const k = ext || '(no extension)';
        stats.other.set(k, (stats.other.get(k) || 0) + 1);
      }
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
 * Scan every library folder. Calls onProgress(stats) a few times a second.
 * Returns { added, changed, missing, stats }.
 */
export async function scanLibrary(db, shell, onProgress = () => {}) {
  // step: 'looking' (walking folders), 'cloud' (asking Windows which files are cloud-only),
  // 'dates' (reading dates from new photos), 'done'.
  const stats = {
    step: 'looking', current: '', folders: 0, files: 0, photos: 0, newPhotos: 0, tooSmall: 0,
    other: new Map(), unreadable: [], unavailable: [], tick: null,
  };
  let lastTell = 0;
  const tell = (force) => {
    const now = Date.now();
    if (!force && now - lastTell < 400) return;
    lastTell = now;
    onProgress(stats);
  };
  stats.tick = () => tell(false);
  const roots = db.prepare('SELECT path FROM folders').all().map((r) => r.path);
  const known = new Map();
  for (const r of db.prepare('SELECT id, path, size, mtime, missing, cloud, thumb, ai_state FROM photos').all()) known.set(r.path, r);

  const seen = new Set();
  const reachableRoots = [];
  let added = 0;
  let changed = 0;
  let found = 0;
  const insert = db.prepare(
    `INSERT INTO photos (path, folder, filename, size, mtime, taken, camera, cloud, added) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const update = db.prepare(
    `UPDATE photos SET size = ?, mtime = ?, taken = ?, camera = ?, cloud = ?, missing = 0, ai_state = 0, clip = NULL, thumb = 0, width = NULL, height = NULL WHERE id = ?`
  );
  const unmiss = db.prepare('UPDATE photos SET missing = 0 WHERE id = ?');
  // Became local (opened, or "always keep on this device"): now we can read its real date.
  const nowLocal = db.prepare('UPDATE photos SET cloud = 0, taken = COALESCE(?, taken), camera = COALESCE(?, camera) WHERE id = ?');
  // Space freed up again: stay away from the file, keep everything we learned.
  const nowCloud = db.prepare('UPDATE photos SET cloud = 1 WHERE id = ?');
  const retryThumb = db.prepare('UPDATE photos SET thumb = 0 WHERE id = ?');
  const retryAi = db.prepare('UPDATE photos SET ai_state = 0 WHERE id = ?');

  let batch = [];
  const flush = () => {
    if (!batch.length) return;
    const work = batch;
    batch = [];
    tx(db, () => work.forEach((fn) => fn()));
  };

  // Files are handled in groups so cloud status can be asked for many at once.
  const handle = async (group) => {
    stats.step = 'cloud';
    tell(true);
    const attrs = shell ? await shell.attributes(group.map((g) => g.file)) : group.map(() => null);
    stats.step = 'dates';
    for (let i = 0; i < group.length; i++) {
      const { file, st } = group[i];
      const cloud = isCloudOnly(attrs[i]) ? 1 : 0;
      const prev = known.get(file);
      stats.current = file;
      tell(false);
      const mtime = Math.round(st.mtimeMs);
      if (prev && prev.size === st.size && prev.mtime === mtime) {
        if (prev.missing) batch.push(() => unmiss.run(prev.id));
        if (prev.cloud && !cloud) {
          const { taken, camera } = await readExif(file);
          batch.push(() => nowLocal.run(taken ?? null, camera ?? null, prev.id));
        } else if (!prev.cloud && cloud) {
          batch.push(() => nowCloud.run(prev.id));
        }
        // Cloud previews that weren't available last time (e.g. offline): try again.
        if (prev.thumb === -2) batch.push(() => retryThumb.run(prev.id));
        if (prev.ai_state === -2) batch.push(() => retryAi.run(prev.id));
      } else {
        // Never read a cloud-only file: that would download it. Use the file's date for now.
        const { taken, camera } = cloud ? {} : await readExif(file);
        const when = taken ?? mtime;
        if (prev) {
          changed++;
          batch.push(() => {
            forgetDerived(db, prev.id);
            update.run(st.size, mtime, when, camera ?? null, cloud, prev.id);
          });
        } else {
          added++;
          stats.newPhotos++;
          batch.push(() =>
            insert.run(file, path.dirname(file), path.basename(file), st.size, mtime, when, camera ?? null, cloud, Date.now())
          );
        }
      }
    }
    flush();
    stats.step = 'looking';
  };

  let group = [];
  for (const root of roots) {
    if (!fs.existsSync(root)) {
      log('Library folder not available (unplugged drive?):', root);
      stats.unavailable.push(root);
      continue;
    }
    reachableRoots.push(root);
    for await (const file of walk(root, stats)) {
      let st;
      try {
        st = await fs.promises.stat(file); // stat does not download cloud files
      } catch {
        continue;
      }
      if (st.size < MIN_BYTES) {
        stats.tooSmall++; // icons and tiny images
        continue;
      }
      seen.add(file);
      found++;
      stats.photos = found;
      tell(false);
      group.push({ file, st });
      if (group.length >= 200) {
        await handle(group);
        group = [];
      }
    }
  }
  if (group.length) await handle(group);
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
  stats.step = 'done';
  stats.current = '';
  tell(true);
  return { added, changed, missing, stats };
}
