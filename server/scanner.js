// Walks the chosen folders and keeps the photos table in step with the disk.
// Read-only with respect to the photos themselves.
import fs from 'node:fs';
import path from 'node:path';
import exifr from 'exifr';
import { IMAGE_EXTS } from './images.js';
import { thumbPath, cropPath, log, readSkipList } from './paths.js';
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

const EXIF_TIMEOUT_MS = 20000;
const EXIF_FIRST = 64 * 1024; // camera info sits at the start of a JPEG
const EXIF_HEAD = 512 * 1024;
const EXIF_WHOLE_MAX = 40 * 1024 * 1024;

/** Reads `length` bytes from the start of a file (or all of it), always closing it again. */
async function readHead(file, length) {
  const fh = await fs.promises.open(file, 'r');
  try {
    const size = (await fh.stat()).size;
    const buf = Buffer.alloc(Math.min(size, length));
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    return { buf: buf.subarray(0, bytesRead), size };
  } finally {
    await fh.close();
  }
}

const EXIF_OPTIONS = {
  pick: ['DateTimeOriginal', 'CreateDate', 'DateTimeDigitized', 'Make', 'Model'],
  reviveValues: true,
};

// We hand exifr the bytes rather than the file name. When exifr opens files itself it calls
// fileHandle.stat() wrongly and never closes the file; on Node 26 that error leaves an open
// file behind, and Node then kills the whole background process when it tidies it up.
async function parseExif(file) {
  // Usually the camera info is in the first 64 KB; only read more when it isn't.
  let { buf, size } = await readHead(file, EXIF_FIRST);
  let x = await exifr.parse(buf, EXIF_OPTIONS).catch(() => null);
  if (!x && size > buf.length) {
    ({ buf, size } = await readHead(file, EXIF_HEAD));
    x = await exifr.parse(buf, EXIF_OPTIONS).catch(() => null);
  }
  if (x || size <= buf.length || size > EXIF_WHOLE_MAX || !/\.(heic|heif|tiff?)$/i.test(file)) return x;
  // HEIC/TIFF can keep the camera info further in: read the whole photo.
  return exifr.parse((await readHead(file, size)).buf, EXIF_OPTIONS).catch(() => null);
}

async function readExif(file) {
  let timer;
  try {
    // A file that is secretly still in the cloud (or on a sleepy network drive) can take
    // ages to read. Don't let one photo hold up the whole scan: use its file date instead.
    const x = await Promise.race([
      parseExif(file),
      new Promise((_, reject) => (timer = setTimeout(() => reject(new Error('timed out')), EXIF_TIMEOUT_MS))),
    ]);
    if (!x) return {};
    const d = x.DateTimeOriginal || x.CreateDate || x.DateTimeDigitized;
    const taken = d instanceof Date && !isNaN(d) && d.getFullYear() > 1900 ? d.getTime() : null;
    const camera = [x.Make, x.Model].filter(Boolean).join(' ').trim() || null;
    return { taken, camera };
  } catch (e) {
    if (e?.message === 'timed out') log(`Reading the date took over ${EXIF_TIMEOUT_MS / 1000}s, skipped:`, file);
    else log('Could not read the date from', file, '-', e?.message);
    return {};
  } finally {
    clearTimeout(timer);
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
export async function scanLibrary(db, shell, onProgress = () => {}, onOpen = () => {}) {
  // step: 'looking' (walking folders), 'cloud' (asking Windows which files are cloud-only),
  // 'dates' (reading dates from new photos), 'done'.
  const stats = {
    step: 'looking', current: '', folders: 0, files: 0, photos: 0, newPhotos: 0, tooSmall: 0,
    other: new Map(), unreadable: [], unavailable: [], tick: null,
    // What it is busy with right now, so a slow step shows "waiting on X for 40s" rather than looking frozen.
    attrs: new Map(),
    stepSince: Date.now(), waitingOn: '', waitingSince: 0, batchDone: 0, batchSize: 0, batches: 0,
  };
  const setStep = (step) => {
    stats.step = step;
    stats.stepSince = Date.now();
  };
  let lastTell = 0;
  const tell = (force) => {
    const now = Date.now();
    if (!force && now - lastTell < 400) return;
    lastTell = now;
    onProgress(stats);
  };
  stats.tick = () => tell(false);
  // Keep reporting even while waiting on something slow, so the elapsed time keeps counting.
  const heartbeat = setInterval(() => tell(true), 2000);
  try {
    return await scanInner();
  } finally {
    clearInterval(heartbeat);
  }

  async function scanInner() {
    const roots = db.prepare('SELECT path FROM folders').all().map((r) => r.path);
    const skip = readSkipList();
    // Say which file we're about to open (so if it freezes or crashes us, it can be skipped next time).
    const exifOf = (file) => {
      if (skip.has(file)) return {};
      onOpen(file);
      return readExif(file);
    };
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
      stats.batches++;
      stats.batchSize = group.length;
      stats.batchDone = 0;
      setStep('cloud');
      tell(true);
      const t0 = Date.now();
      const attrs = shell ? await shell.attributes(group.map((g) => g.file)) : group.map(() => null);
      if (Date.now() - t0 > 10000) log(`Checking cloud status of ${group.length} files took ${Math.round((Date.now() - t0) / 1000)}s`);
      const unknown = attrs.filter((a) => a == null).length;
      if (shell?.enabled && unknown) log(`Cloud status unknown for ${unknown} of ${group.length} files (treated as on this PC)`);
      setStep('dates');
      for (let i = 0; i < group.length; i++) {
        const { file, st } = group[i];
        const cloud = isCloudOnly(attrs[i]) ? 1 : 0;
        // Tally the Windows attributes seen, so the log shows how cloud status was decided.
        const key = attrs[i] == null ? 'unknown' : '0x' + attrs[i].toString(16);
        const a = stats.attrs.get(key) || { n: 0, cloud };
        a.n++;
        stats.attrs.set(key, a);
        const prev = known.get(file);
        stats.current = file;
        stats.batchDone = i;
        stats.waitingOn = file;
        stats.waitingSince = Date.now();
        tell(false);
        const mtime = Math.round(st.mtimeMs);
        if (prev && prev.size === st.size && prev.mtime === mtime) {
          if (prev.missing) batch.push(() => unmiss.run(prev.id));
          if (prev.cloud && !cloud) {
            const { taken, camera } = await exifOf(file);
            batch.push(() => nowLocal.run(taken ?? null, camera ?? null, prev.id));
          } else if (!prev.cloud && cloud) {
            batch.push(() => nowCloud.run(prev.id));
          }
          // Cloud previews that weren't available last time (e.g. offline): try again.
          if (prev.thumb === -2) batch.push(() => retryThumb.run(prev.id));
          if (prev.ai_state === -2) batch.push(() => retryAi.run(prev.id));
        } else {
          // Never read a cloud-only file: that would download it. Use the file's date for now.
          const { taken, camera } = cloud ? {} : await exifOf(file);
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
      stats.batchDone = group.length;
      stats.waitingOn = '';
      // Only slow batches are worth a line in the log (progress is logged every 15s anyway).
      const took = (Date.now() - t0) / 1000;
      if (took > 5) log(`Batch of ${group.length} photos took ${took.toFixed(1)}s, in`, path.dirname(group[0].file));
      flush();
      setStep('looking');
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
    onOpen(null);
    setStep('done');
    stats.current = '';
    stats.waitingOn = '';
    tell(true);
    return { added, changed, missing, stats };
  }
}
