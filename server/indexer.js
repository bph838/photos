// Background worker (separate, low-priority process):
//   1. scans the library folders for new / changed / removed photos
//   2. makes thumbnails so the gallery is quick
//   3. runs the AI: faces, pets, and CLIP "search by description"
// It reports progress to the main server over IPC.
import fs from 'node:fs';
import sharp from 'sharp';
import { openDb, toBlob, tx } from './db.js';
import { log } from './paths.js';
import { scanLibrary } from './scanner.js';
import { makeThumb, makeCloudThumb, openImage, loadRgb, loadCloudRgb } from './images.js';
import { ClusterIndex } from './cluster.js';
import { Shell } from './win/shell.js';

const THREADS = Number(process.env.FAMILY_PHOTOS_THREADS || 3);
const RESCAN_EVERY_MS = 30 * 60 * 1000;

// Put the reason for a crash in the log (otherwise it only goes to a console nobody sees).
for (const ev of ['uncaughtException', 'unhandledRejection']) {
  process.on(ev, (e) => {
    log(`Background work crashed (${ev}):`, e instanceof Error ? e : String(e));
    process.exit(1);
  });
}

const db = openDb();
const clusters = new ClusterIndex(db);
// Cloud previews are mostly waiting on the network, so a few helpers run side by side.
const shell = new Shell(3);
const status = { phase: 'starting', done: 0, total: 0, message: '' };
let scanRequested = true;
let lastScan = 0;
let wake = null;
let watchers = [];

// Progress also goes in the log (on every change of phase, and every 15s), so a log shared
// for help shows what the app was doing and how fast, not just the errors.
let loggedPhase = '';
let loggedAt = 0;
function report(patch) {
  Object.assign(status, patch);
  process.send?.({ type: 'status', status });
  const now = Date.now();
  if (status.phase !== loggedPhase || now - loggedAt > 15000) {
    loggedPhase = status.phase;
    loggedAt = now;
    const where = status.phase === 'scanning' && status.scan?.current ? ` | now: ${status.scan.current}` : '';
    log(`Status (${status.phase}): ${status.message}${where}`);
  }
}

process.on('message', (msg) => {
  if (msg?.type === 'rescan') scanRequested = true;
  if (msg?.type === 'clustersChanged') clusters.dirty = true;
  wake?.();
});
process.on('disconnect', () => process.exit(0));

function sleep(ms) {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    wake = () => {
      clearTimeout(t);
      resolve();
    };
  });
}

// Notice new photos arriving (e.g. copied off a phone) without waiting for the next full rescan.
function watchFolders() {
  for (const w of watchers) w.close();
  watchers = [];
  let timer;
  for (const { path: root } of db.prepare('SELECT path FROM folders').all()) {
    try {
      const w = fs.watch(root, { recursive: true }, () => {
        clearTimeout(timer);
        timer = setTimeout(() => {
          scanRequested = true;
          wake?.();
        }, 15000);
      });
      w.on('error', () => {});
      watchers.push(w);
    } catch {}
  }
}

// One friendly line for the sidebar while looking for photos.
const secsSince = (t) => Math.max(0, Math.round((Date.now() - t) / 1000));
const fileName = (p) => p.split(/[\\/]/).pop();
function scanMessage(s) {
  const n = (x) => x.toLocaleString();
  const found = `${n(s.photos)} photo${s.photos === 1 ? '' : 's'} found`;
  if (s.step === 'cloud') {
    const t = secsSince(s.stepSince);
    return `Looking for photos... ${found}. Asking Windows which of the next ${n(s.batchSize)} are only in OneDrive/iCloud` +
      (t >= 5 ? ` (${t}s so far)` : '...');
  }
  if (s.step === 'dates') {
    const wait = s.waitingOn ? secsSince(s.waitingSince) : 0;
    return `Looking for photos... ${found}. Reading dates: ${n(s.batchDone)} of ${n(s.batchSize)} in this batch` +
      (wait >= 5 ? ` (waiting ${wait}s on ${fileName(s.waitingOn)})` : '');
  }
  if (s.step === 'done') return `Finished looking: ${found} in ${n(s.folders)} folder${s.folders === 1 ? '' : 's'}`;
  return `Looking for photos... ${found} so far (${n(s.folders)} folders, ${n(s.files)} files checked)`;
}

// The details, for the "My folders" page: where it is now, and anything worth explaining.
function scanDetail(s) {
  return {
    step: s.step,
    current: s.current,
    stepSecs: secsSince(s.stepSince),
    waitingOn: s.waitingOn,
    waitingSecs: s.waitingOn ? secsSince(s.waitingSince) : 0,
    batchDone: s.batchDone,
    batchSize: s.batchSize,
    batches: s.batches,
    folders: s.folders,
    files: s.files,
    photos: s.photos,
    newPhotos: s.newPhotos,
    tooSmall: s.tooSmall,
    other: [...s.other].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([ext, count]) => ({ ext, count })),
    otherTotal: [...s.other.values()].reduce((a, b) => a + b, 0),
    unreadable: s.unreadable.slice(0, 10),
    unreadableTotal: s.unreadable.length,
    unavailable: s.unavailable,
  };
}

async function doScan() {
  scanRequested = false;
  report({ phase: 'scanning', done: 0, total: 0, message: 'Looking for photos...', scan: null });
  const res = await scanLibrary(
    db,
    shell,
    (s) => report({ message: scanMessage(s), scan: scanDetail(s) }),
    (file) => process.send?.({ type: 'opening', file })
  );
  lastScan = Date.now();
  log('Scan finished', JSON.stringify({ ...res, stats: scanDetail(res.stats) }));
  watchFolders();
}

async function doThumbs() {
  const total = db.prepare('SELECT COUNT(*) n FROM photos WHERE thumb = 0 AND missing = 0').get().n;
  if (!total) return false;
  let done = 0;
  const pick = db.prepare('SELECT id, path, cloud FROM photos WHERE thumb = 0 AND missing = 0 ORDER BY taken DESC LIMIT 24');
  const setOk = db.prepare('UPDATE photos SET thumb = 1, width = ?, height = ? WHERE id = ?');
  const setBad = db.prepare('UPDATE photos SET thumb = ? WHERE id = ?');
  while (!scanRequested) {
    const rows = pick.all();
    if (!rows.length) break;
    const results = await Promise.all(
      rows.map(async (r) => {
        if (r.cloud) {
          // Preview from OneDrive/iCloud via Windows; the photo itself stays in the cloud.
          try {
            const dims = await makeCloudThumb(r.id, r.path, shell);
            if (dims) return { r, w: dims.width, h: dims.height };
          } catch (e) {
            log('No cloud preview for', r.path, e.message);
          }
          return { r, bad: -2 }; // try again on the next scan
        }
        try {
          await makeThumb(r.id, r.path);
          const meta = await (await openImage(r.path)).metadata();
          const swap = (meta.orientation || 1) >= 5;
          return { r, w: swap ? meta.height : meta.width, h: swap ? meta.width : meta.height };
        } catch (e) {
          log('Cannot read photo', r.path, e.message);
          return { r, bad: -1 };
        }
      })
    );
    tx(db, () => results.forEach((x) => (x.bad ? setBad.run(x.bad, x.r.id) : setOk.run(x.w, x.h, x.r.id))));
    done += rows.length;
    const cloudLeft = rows.some((r) => r.cloud) ? ' (getting previews from OneDrive/iCloud)' : '';
    report({ phase: 'thumbnails', done, total, message: `Preparing photos: ${done.toLocaleString()} of ${total.toLocaleString()}${cloudLeft}` });
  }
  return true;
}

let ai = null;
async function loadAi() {
  if (ai) return ai;
  const starting = () => report({ phase: 'loading', done: 0, total: 0, message: 'Starting the face and pet finder...' });
  // While downloading, show MB and a progress bar; otherwise just a message.
  const say = (message, p) =>
    p ? report({ phase: 'downloading', done: p.done, total: p.total, message }) : report({ phase: 'loading', done: 0, total: 0, message });
  starting();
  const { ensureFaceModels } = await import('./setup-models.js');
  const { downloadTracker } = await import('./progress.js');
  await ensureFaceModels(say);
  starting();
  const faces = await import('./ai/faces.js');
  const clip = await import('./ai/clip.js');
  await faces.loadFaceModels(THREADS);
  await clip.loadVision(THREADS, downloadTracker('Downloading photo search model (part 1 of 2)', say));
  await clip.loadText(1, downloadTracker('Downloading photo search model (part 2 of 2)', say));
  await clip.loadDetector(THREADS, downloadTracker('Downloading pet finder model', say));
  starting();
  // Zero-shot "is there an animal in this photo?" check, so the slow pet
  // detector only runs on photos likely to contain one.
  const prompts = [
    'a photo of a dog', 'a photo of a cat',
    'a photo of people', 'a photo of a person', 'a photo of a landscape', 'a photo of food',
    'a photo of a room', 'a photo of a building', 'a photo of a document', 'a photo of a car',
    'a photo of flowers', 'a photo of a baby',
  ];
  const promptEmbs = [];
  for (const p of prompts) promptEmbs.push(await clip.embedText(p));
  ai = { faces, clip, promptEmbs };
  return ai;
}

function petChance(clipEmb) {
  const logits = ai.promptEmbs.map((p) => 100 * ai.clip.dot(clipEmb, p));
  const m = Math.max(...logits);
  const ex = logits.map((l) => Math.exp(l - m));
  const sum = ex.reduce((a, b) => a + b, 0);
  return (ex[0] + ex[1]) / sum;
}

async function analysePhoto(row) {
  // Cloud-only photos are checked using the OneDrive/iCloud preview (~768px), so nothing is
  // downloaded. Tests showed faces in previews match the full photo almost exactly.
  const img = row.cloud ? await loadCloudRgb(row.path, shell) : await loadRgb(row.path, 1600);
  const minPet = Math.max(24, 0.03 * Math.max(img.width, img.height));
  const found = [];
  for (const f of await ai.faces.findFaces(img)) found.push({ kind: 'face', label: null, ...f });

  const clipEmb = await ai.clip.embedImage(img);

  if (petChance(clipEmb) > 0.12) {
    for (const p of await ai.clip.detectPets(img)) {
      const { xmin, ymin, xmax, ymax } = p.box;
      const x = Math.max(0, Math.floor(xmin)), y = Math.max(0, Math.floor(ymin));
      const w = Math.min(img.width - x, Math.ceil(xmax - xmin)), h = Math.min(img.height - y, Math.ceil(ymax - ymin));
      if (w < minPet || h < minPet) continue;
      const crop = await sharp(img.data, { raw: { width: img.width, height: img.height, channels: 3 } })
        .extract({ left: x, top: y, width: w, height: h })
        .raw()
        .toBuffer({ resolveWithObject: true });
      const emb = await ai.clip.embedImage({ data: crop.data, width: crop.info.width, height: crop.info.height });
      found.push({ kind: 'pet', label: p.label, x: x / img.width, y: y / img.height, w: w / img.width, h: h / img.height, score: p.score, emb });
    }
  }
  return { clipEmb, found };
}

async function doAi() {
  const total = db.prepare('SELECT COUNT(*) n FROM photos WHERE ai_state = 0 AND missing = 0 AND thumb = 1').get().n;
  if (!total) return false;
  await loadAi();
  const pick = db.prepare('SELECT id, path, cloud FROM photos WHERE ai_state = 0 AND missing = 0 AND thumb = 1 ORDER BY taken DESC LIMIT 20');
  const setLater = db.prepare('UPDATE photos SET ai_state = -2 WHERE id = ?'); // retried on the next scan
  const insFace = db.prepare(
    'INSERT INTO faces (photo_id, kind, label, x, y, w, h, score, emb, cluster_id, person_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  );
  const setDone = db.prepare('UPDATE photos SET ai_state = 1, clip = ? WHERE id = ?');
  const setFail = db.prepare('UPDATE photos SET ai_state = -1 WHERE id = ?');
  let done = 0;
  const started = Date.now();
  while (!scanRequested) {
    const rows = pick.all();
    if (!rows.length) break;
    for (const row of rows) {
      if (scanRequested) break;
      let result;
      try {
        result = await analysePhoto(row);
      } catch (e) {
        log('AI failed for', row.path, e.message);
        (row.cloud ? setLater : setFail).run(row.id);
        continue;
      }
      tx(db, () => {
        for (const f of result.found) {
          const cl = clusters.assign(f.kind, f.emb);
          insFace.run(row.id, f.kind, f.label, f.x, f.y, f.w, f.h, f.score, toBlob(f.emb), cl.id, cl.person_id ?? null);
        }
        setDone.run(toBlob(result.clipEmb), row.id);
      });
      done++;
      const perPhoto = (Date.now() - started) / done;
      const left = Math.round(((total - done) * perPhoto) / 60000);
      report({
        phase: 'ai',
        done,
        total,
        message: `Finding people and pets: ${done.toLocaleString()} of ${total.toLocaleString()}` + (done > 20 ? ` (about ${left < 90 ? left + ' min' : Math.round(left / 60) + ' hours'} left)` : ''),
      });
    }
  }
  return true;
}

async function main() {
  log('Indexer started');
  for (;;) {
    try {
      if (scanRequested || Date.now() - lastScan > RESCAN_EVERY_MS) await doScan();
      if (await doThumbs()) continue;
      if (await doAi()) continue;
      report({ phase: 'idle', done: 0, total: 0, message: 'All photos are up to date' });
      await sleep(60000);
    } catch (e) {
      log('Indexer error', e);
      report({ phase: 'error', message: 'Something went wrong while indexing; will retry shortly.' });
      await sleep(30000);
    }
  }
}

main();
