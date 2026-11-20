// Family Photos: main server. Serves the web app on http://localhost:4321
// (this computer only) and runs the background indexer.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fork, spawn, execFile } from 'node:child_process';
import express from 'express';
import { openDb, fromBlob, tx } from './db.js';
import { APP_ROOT, PORT, LOG_PATH, log, logTail, thumbPath, cropPath, addToSkipList } from './paths.js';
import { makeThumb, makeCloudThumb, makeDisplay, makeCrop, isHeic } from './images.js';
import { Shell } from './win/shell.js';
import { detachFromCluster, personCentroid, unit, dot, SUGGEST_THRESHOLD } from './cluster.js';
import { Searcher } from './search.js';

const URL_BASE = `http://localhost:${PORT}`;
const NO_BROWSER = process.argv.includes('--no-browser');

// ---------- single instance: if already running, just show the window ----------
try {
  const r = await fetch(`${URL_BASE}/api/ping`, { signal: AbortSignal.timeout(1500) });
  if (r.ok) {
    if (!NO_BROWSER) openBrowser();
    process.exit(0);
  }
} catch {}

const db = openDb();
const searcher = new Searcher(db);
const shell = new Shell(2);

// ---------- background indexer ----------
let indexer = null;
let indexStatus = { phase: 'starting', message: 'Starting...' };
let lastHeard = 0;
let opening = null; // the photo the indexer is reading right now, while looking for photos
function startIndexer() {
  indexer = fork(path.join(APP_ROOT, 'server', 'indexer.js'), [], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
  lastHeard = Date.now();
  opening = null;
  try {
    os.setPriority(indexer.pid, os.constants.priority.PRIORITY_BELOW_NORMAL);
  } catch {}
  indexer.on('message', (m) => {
    if (m?.type === 'opening') opening = m.file;
    if (m?.type === 'status') {
      indexStatus = m.status;
      lastHeard = Date.now();
      if (m.status.phase === 'idle') searcher.clearCache();
    }
  });
  indexer.on('exit', (code, signal) => {
    log('Indexer exited with code', code, signal || '');
    // Crashed while reading a photo: don't open that photo again, or it would crash every time.
    const file = indexStatus.phase === 'scanning' && opening;
    if ((code || signal) && file) {
      log('Will not read this photo again (it stopped the indexer):', file);
      addToSkipList(file);
    }
    indexer = null;
    indexStatus = { phase: 'starting', message: 'Restarting the background work...' };
    setTimeout(startIndexer, 10000);
  });
}
// While looking for photos the indexer reports every 2 seconds. If it goes quiet it has
// frozen (e.g. on a damaged photo or a stuck drive): restart it, skipping that photo.
setInterval(() => {
  if (!indexer || indexStatus.phase !== 'scanning' || Date.now() - lastHeard < 60000) return;
  log('Indexer stopped responding while on', opening || indexStatus.scan?.current || '(unknown)');
  lastHeard = Date.now();
  indexer.kill(); // the exit handler records the photo and restarts
}, 10000).unref();
const tellIndexer = (type) => indexer?.send({ type });
const clustersChanged = () => {
  searcher.clearCache();
  tellIndexer('clustersChanged');
};

// ---------- helpers ----------
function openBrowser() {
  const edge = [
    path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  ].find((p) => fs.existsSync(p));
  if (process.platform !== 'win32') return spawn('xdg-open', [URL_BASE], { detached: true, stdio: 'ignore' }).unref();
  // Edge "app mode" gives a clean window without tabs or an address bar.
  if (edge) spawn(edge, [`--app=${URL_BASE}`, '--start-maximized'], { detached: true, stdio: 'ignore' }).unref();
  else spawn('explorer.exe', [URL_BASE], { detached: true, stdio: 'ignore' }).unref();
}

function explorer(arg) {
  spawn('explorer.exe', [arg], { detached: true, stdio: 'ignore', windowsVerbatimArguments: true }).unref();
}

function powershell(script) {
  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-Command', `[Console]::OutputEncoding=[Text.Encoding]::UTF8; ${script}`],
      { windowsHide: true, timeout: 10 * 60 * 1000 },
      (err, stdout) => (err ? reject(err) : resolve(stdout.trim()))
    );
  });
}

let desktopDir = null;
async function getDesktop() {
  if (desktopDir) return desktopDir;
  try {
    desktopDir = await powershell("[Environment]::GetFolderPath('Desktop')");
  } catch {}
  if (!desktopDir) desktopDir = path.join(os.homedir(), 'Desktop');
  return desktopDir;
}

function photoById(id) {
  return db.prepare('SELECT * FROM photos WHERE id = ?').get(id);
}

function findOrCreatePerson(name, kind) {
  name = String(name || '').trim().replace(/\s+/g, ' ');
  if (!name) throw Object.assign(new Error('Please type a name'), { status: 400, userMessage: 'Please type a name' });
  const existing = db.prepare('SELECT * FROM persons WHERE lower(name) = lower(?) AND kind = ?').get(name, kind);
  if (existing) return existing;
  const r = db.prepare('INSERT INTO persons (name, kind, created) VALUES (?, ?, ?)').run(name, kind, Date.now());
  return db.prepare('SELECT * FROM persons WHERE id = ?').get(Number(r.lastInsertRowid));
}

/** Give a whole group (cluster) a name. Faces already tagged as someone else are left alone. */
function assignCluster(clusterId, personId) {
  db.prepare('UPDATE clusters SET person_id = ?, ignored = 0 WHERE id = ?').run(personId, clusterId);
  db.prepare(
    `UPDATE faces SET person_id = ? WHERE cluster_id = ? AND (person_id IS NULL OR person_id = ?)
       AND id NOT IN (SELECT face_id FROM rejections WHERE person_id = ?)`
  ).run(personId, clusterId, personId, personId);
  db.prepare('DELETE FROM cluster_rejections WHERE cluster_id = ? AND person_id = ?').run(clusterId, personId);
}

function personSummary(p) {
  const count = db.prepare('SELECT COUNT(DISTINCT f.photo_id) n FROM faces f JOIN photos ph ON ph.id = f.photo_id WHERE f.person_id = ? AND ph.missing = 0').get(p.id).n;
  let cover = p.cover_face_id && db.prepare('SELECT id FROM faces WHERE id = ? AND person_id = ?').get(p.cover_face_id, p.id);
  if (!cover) cover = db.prepare('SELECT id FROM faces WHERE person_id = ? ORDER BY confirmed DESC, score * w DESC LIMIT 1').get(p.id);
  return { id: p.id, name: p.name, kind: p.kind, count, cover: cover?.id ?? null };
}

function photoListSql(q) {
  const where = ['p.missing = 0', 'p.thumb != -1'];
  const args = [];
  if (q.person) {
    for (const id of String(q.person).split(',').map(Number).filter(Boolean)) {
      where.push('EXISTS (SELECT 1 FROM faces f WHERE f.photo_id = p.id AND f.person_id = ?)');
      args.push(id);
    }
  }
  if (q.pet === 'dog' || q.pet === 'cat') {
    where.push("EXISTS (SELECT 1 FROM faces f WHERE f.photo_id = p.id AND f.kind = 'pet' AND f.label = ?)");
    args.push(q.pet);
  }
  if (q.favorites === '1') where.push('p.favorite = 1');
  if (q.year) {
    where.push("strftime('%Y', p.taken / 1000, 'unixepoch', 'localtime') = ?");
    args.push(String(q.year));
  }
  if (q.folder) {
    where.push('p.folder = ?');
    args.push(String(q.folder));
  }
  if (q.print === '1') where.push('p.id IN (SELECT photo_id FROM print_list)');
  return { where: where.join(' AND '), args };
}

const asyncRoute = (fn) => (req, res) =>
  Promise.resolve(fn(req, res)).catch((e) => {
    if (!e.status) log('Request failed', req.method, req.url, e);
    res.status(e.status || 500).json({ error: e.status ? e.message : 'Something went wrong' });
  });

// ---------- app ----------
const app = express();
app.use(express.json());
// Only accept requests from this computer's own pages (no other website can drive the API).
app.use('/api', (req, res, next) => {
  const host = req.headers.host;
  if (host !== `localhost:${PORT}` && host !== `127.0.0.1:${PORT}`) return res.status(403).end();
  const origin = req.headers.origin;
  if (origin && origin !== URL_BASE && origin !== `http://127.0.0.1:${PORT}`) return res.status(403).end();
  next();
});
app.use(express.static(path.join(APP_ROOT, 'public'), { index: 'index.html' }));

app.get('/api/ping', (req, res) => res.json({ ok: true }));

app.get('/api/status', (req, res) => {
  const c = db.prepare(
    `SELECT COUNT(*) total, SUM(ai_state IN (1, -1)) analysed, SUM(thumb = 1) thumbs, SUM(cloud = 1) cloud, SUM(cloud = 1 AND ai_state NOT IN (1, -1)) cloudUnchecked FROM photos WHERE missing = 0`
  ).get();
  const folders = db.prepare('SELECT COUNT(*) n FROM folders').get().n;
  res.json({
    indexer: indexStatus, total: c.total, analysed: c.analysed || 0, thumbs: c.thumbs || 0, folders,
    cloud: c.cloud || 0, cloudUnchecked: c.cloudUnchecked || 0,
  });
});

// ----- log (shown on the My folders page, and easy to share when asking for help) -----
app.get('/api/log', (req, res) => {
  res.json({ lines: logTail(Math.min(400, Number(req.query.lines) || 40)), path: LOG_PATH });
});
app.post('/api/log/show', (req, res) => {
  if (!fs.existsSync(LOG_PATH)) log('Log opened');
  explorer(`/select,"${LOG_PATH}"`);
  res.json({ ok: true });
});

// ----- folders -----
app.get('/api/folders', (req, res) => {
  const rows = db.prepare('SELECT id, path FROM folders ORDER BY path').all();
  for (const r of rows) {
    r.count = db.prepare('SELECT COUNT(*) n FROM photos WHERE missing = 0 AND (folder = ? OR folder LIKE ?)').get(r.path, r.path.replace(/[\\/]$/, '') + path.sep + '%').n;
    r.available = fs.existsSync(r.path);
  }
  res.json(rows);
});
app.post('/api/folders/pick', asyncRoute(async (req, res) => {
  const out = await powershell(
    "Add-Type -AssemblyName System.Windows.Forms; $f = New-Object System.Windows.Forms.FolderBrowserDialog; $f.Description = 'Choose a folder that has photos in it'; $f.ShowNewFolderButton = $false; $f.SelectedPath = [Environment]::GetFolderPath('MyPictures'); $w = New-Object System.Windows.Forms.Form -Property @{TopMost = $true}; if ($f.ShowDialog($w) -eq 'OK') { [Console]::Out.Write($f.SelectedPath) }"
  );
  res.json({ path: out || null });
}));
app.post('/api/folders', (req, res) => {
  let p = String(req.body?.path || '').trim().replace(/^"|"$/g, '');
  if (!p || !path.isAbsolute(p) || !fs.existsSync(p) || !fs.statSync(p).isDirectory()) {
    return res.status(400).json({ error: 'That folder could not be found.' });
  }
  p = path.resolve(p);
  const existing = db.prepare('SELECT path FROM folders').all().map((r) => r.path.toLowerCase());
  if (existing.some((e) => p.toLowerCase() === e || p.toLowerCase().startsWith(e.replace(/[\\/]$/, '') + path.sep))) {
    return res.status(400).json({ error: 'That folder is already included.' });
  }
  db.prepare('INSERT INTO folders (path) VALUES (?)').run(p);
  tellIndexer('rescan');
  res.json({ ok: true });
});
app.delete('/api/folders/:id', (req, res) => {
  db.prepare('DELETE FROM folders WHERE id = ?').run(Number(req.params.id));
  tellIndexer('rescan');
  res.json({ ok: true });
});
app.post('/api/rescan', (req, res) => {
  tellIndexer('rescan');
  res.json({ ok: true });
});

// ----- photo lists -----
app.get('/api/photos', asyncRoute(async (req, res) => {
  const offset = Math.max(0, Number(req.query.offset) || 0);
  const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 200));
  let ids;
  let total;
  let understood = null;
  const cols = 'id, taken, width w, height h, favorite fav, cloud';
  if (req.query.q && String(req.query.q).trim()) {
    const r = await searcher.search(String(req.query.q).trim());
    understood = r.understood;
    total = r.ids.length;
    ids = r.ids.slice(offset, offset + limit);
    const get = db.prepare(`SELECT ${cols} FROM photos WHERE id = ?`);
    return res.json({ total, understood, items: ids.map((id) => get.get(id)).filter(Boolean) });
  }
  const { where, args } = photoListSql(req.query);
  total = db.prepare(`SELECT COUNT(*) n FROM photos p WHERE ${where}`).get(...args).n;
  const items = db
    .prepare(`SELECT ${cols} FROM photos p WHERE ${where} ORDER BY taken DESC, id DESC LIMIT ? OFFSET ?`)
    .all(...args, limit, offset);
  res.json({ total, items });
}));

// Photo counts per month, newest first, in the same order as /api/photos — drives the timeline.
app.get('/api/months', (req, res) => {
  const { where, args } = photoListSql(req.query);
  res.json(
    db.prepare(
      `SELECT strftime('%Y-%m', taken / 1000, 'unixepoch', 'localtime') ym, COUNT(*) count
       FROM photos p WHERE ${where} GROUP BY ym ORDER BY ym DESC`
    ).all(...args)
  );
});

app.get('/api/years', (req, res) => {
  res.json(
    db.prepare(
      `SELECT strftime('%Y', taken / 1000, 'unixepoch', 'localtime') year, COUNT(*) count
       FROM photos WHERE missing = 0 AND thumb != -1 GROUP BY year ORDER BY year DESC`
    ).all()
  );
});

// ----- a single photo -----
app.get('/api/photo/:id', (req, res) => {
  const p = photoById(Number(req.params.id));
  if (!p) return res.status(404).json({ error: 'Not found' });
  const faces = db
    .prepare(
      `SELECT f.id, f.kind, f.label, f.x, f.y, f.w, f.h, f.person_id, f.confirmed, pe.name
       FROM faces f LEFT JOIN persons pe ON pe.id = f.person_id WHERE f.photo_id = ? ORDER BY f.x`
    )
    .all(p.id);
  const inPrint = !!db.prepare('SELECT 1 FROM print_list WHERE photo_id = ?').get(p.id);
  res.json({
    id: p.id, path: p.path, folder: p.folder, filename: p.filename, size: p.size, taken: p.taken,
    camera: p.camera, w: p.width, h: p.height, favorite: !!p.favorite, missing: !!p.missing,
    analysed: p.ai_state === 1 || p.ai_state === -1, cloud: !!p.cloud, inPrint, faces,
  });
});

app.get('/api/photo/:id/thumb', asyncRoute(async (req, res) => {
  const p = photoById(Number(req.params.id));
  if (!p) return res.status(404).end();
  const file = thumbPath(p.id);
  if (!fs.existsSync(file)) {
    try {
      if (p.cloud) {
        // Never read a cloud-only file here: ask Windows for OneDrive/iCloud's preview instead.
        const dims = await makeCloudThumb(p.id, p.path, shell);
        if (!dims) return sendNoPreview(res);
        db.prepare('UPDATE photos SET thumb = 1, width = ?, height = ? WHERE id = ?').run(dims.width, dims.height, p.id);
      } else {
        await makeThumb(p.id, p.path);
      }
    } catch {
      return p.cloud ? sendNoPreview(res) : res.status(404).end();
    }
  }
  res.set('Cache-Control', 'private, max-age=604800');
  res.sendFile(file);
}));

// Shown for a cloud photo whose preview isn't available yet (e.g. offline).
function sendNoPreview(res) {
  res.set('Cache-Control', 'no-store');
  res.type('svg').send(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 90"><rect width="120" height="90" fill="#d8d0c4"/>` +
      `<path d="M44 58h34a12 12 0 0 0 0-24 16 16 0 0 0-30-4 13 13 0 0 0-4 28z" fill="#fff" opacity=".9"/></svg>`
  );
}

app.get('/api/photo/:id/view', asyncRoute(async (req, res) => {
  const p = photoById(Number(req.params.id));
  if (!p || !fs.existsSync(p.path)) return res.status(404).end();
  res.set('Cache-Control', 'private, max-age=3600');
  const ext = path.extname(p.path).toLowerCase();
  // Browsers show these directly (and respect EXIF rotation); anything else is converted.
  if (['.jpg', '.jpeg', '.png', '.webp', '.gif'].includes(ext) && p.size < 25 * 1024 * 1024 && !isHeic(p.path)) {
    return res.sendFile(p.path);
  }
  res.type('jpeg').send(await makeDisplay(p.path));
}));

app.post('/api/photo/:id/favorite', (req, res) => {
  db.prepare('UPDATE photos SET favorite = ? WHERE id = ?').run(req.body?.value ? 1 : 0, Number(req.params.id));
  res.json({ ok: true });
});

app.post('/api/photo/:id/reveal', (req, res) => {
  const p = photoById(Number(req.params.id));
  if (!p || !fs.existsSync(p.path)) return res.status(404).json({ error: 'This photo is no longer in that place.' });
  explorer(`/select,"${p.path}"`);
  res.json({ ok: true });
});
app.post('/api/photo/:id/open', (req, res) => {
  const p = photoById(Number(req.params.id));
  if (!p || !fs.existsSync(p.path)) return res.status(404).json({ error: 'This photo is no longer in that place.' });
  explorer(`"${p.path}"`);
  res.json({ ok: true });
});

// ----- faces & pets -----
app.get('/api/face/:id/crop', asyncRoute(async (req, res) => {
  const f = db.prepare('SELECT f.*, p.path, p.cloud FROM faces f JOIN photos p ON p.id = f.photo_id WHERE f.id = ?').get(Number(req.params.id));
  if (!f) return res.status(404).end();
  try {
    // Cloud-only photo: crop from the OneDrive/iCloud preview so nothing is downloaded.
    let file;
    if (f.cloud && !fs.existsSync(cropPath(f.id))) {
      const png = path.join(os.tmpdir(), `familyphotos-crop-${f.id}-${Date.now()}.png`);
      try {
        const ok = await shell.thumbnail(f.path, png);
        file = await makeCrop(f, ok ? png : thumbPath(f.photo_id));
      } finally {
        fs.rmSync(png, { force: true });
      }
    } else {
      file = await makeCrop(f, f.path);
    }
    res.set('Cache-Control', 'private, max-age=604800');
    res.sendFile(file);
  } catch {
    res.status(404).end();
  }
}));

// Name one face in the viewer. Its look-alike group gets the name too, if that group has none yet.
app.post('/api/face/:id/name', (req, res) => {
  const f = db.prepare('SELECT * FROM faces WHERE id = ?').get(Number(req.params.id));
  if (!f) return res.status(404).json({ error: 'Not found' });
  const person = findOrCreatePerson(req.body?.name, f.kind === 'pet' ? 'pet' : 'person');
  tx(db, () => {
    if (f.person_id && f.person_id !== person.id) {
      // Re-tagging: this face was wrongly someone else; take it out of its group.
      db.prepare('INSERT OR IGNORE INTO rejections (face_id, person_id) VALUES (?, ?)').run(f.id, f.person_id);
      detachFromCluster(db, f);
    } else if (f.cluster_id) {
      const cl = db.prepare('SELECT person_id FROM clusters WHERE id = ?').get(f.cluster_id);
      if (cl && !cl.person_id) assignCluster(f.cluster_id, person.id);
    }
    db.prepare('UPDATE faces SET person_id = ?, confirmed = 1 WHERE id = ?').run(person.id, f.id);
    db.prepare('DELETE FROM rejections WHERE face_id = ? AND person_id = ?').run(f.id, person.id);
  });
  clustersChanged();
  res.json({ person: personSummary(person) });
});

// "That's not them"
app.post('/api/face/:id/unname', (req, res) => {
  const f = db.prepare('SELECT * FROM faces WHERE id = ?').get(Number(req.params.id));
  if (!f) return res.status(404).json({ error: 'Not found' });
  tx(db, () => {
    if (f.person_id) db.prepare('INSERT OR IGNORE INTO rejections (face_id, person_id) VALUES (?, ?)').run(f.id, f.person_id);
    detachFromCluster(db, f);
    db.prepare('UPDATE faces SET person_id = NULL, confirmed = 0 WHERE id = ?').run(f.id);
  });
  clustersChanged();
  res.json({ ok: true });
});

// "That isn't a face at all" (e.g. a pattern on a jumper)
app.post('/api/face/:id/delete', (req, res) => {
  const f = db.prepare('SELECT * FROM faces WHERE id = ?').get(Number(req.params.id));
  if (!f) return res.status(404).json({ error: 'Not found' });
  tx(db, () => {
    detachFromCluster(db, f);
    db.prepare('DELETE FROM faces WHERE id = ?').run(f.id);
  });
  clustersChanged();
  res.json({ ok: true });
});

// ----- people & pets -----
app.get('/api/people', (req, res) => {
  const kind = req.query.kind === 'pet' ? 'pet' : 'person';
  const faceKind = kind === 'pet' ? 'pet' : 'face';
  const named = db.prepare('SELECT * FROM persons WHERE kind = ?').all(kind).map(personSummary).filter((p) => p.count > 0);
  named.sort((a, b) => b.count - a.count);
  const minSize = kind === 'pet' ? 2 : 3;
  const groups = db
    .prepare(
      `SELECT c.id, COUNT(DISTINCT f.photo_id) count FROM clusters c JOIN faces f ON f.cluster_id = c.id
       JOIN photos p ON p.id = f.photo_id AND p.missing = 0
       WHERE c.kind = ? AND c.person_id IS NULL AND c.ignored = 0 AND f.person_id IS NULL
       GROUP BY c.id HAVING count >= ? ORDER BY count DESC LIMIT 80`
    )
    .all(faceKind, minSize)
    .map((g) => ({
      id: g.id,
      count: g.count,
      faces: db.prepare('SELECT id FROM faces WHERE cluster_id = ? AND person_id IS NULL ORDER BY score * w DESC LIMIT 4').all(g.id).map((r) => r.id),
    }));
  let pets = null;
  if (kind === 'pet') {
    pets = db.prepare(
      `SELECT f.label, COUNT(DISTINCT f.photo_id) n FROM faces f JOIN photos p ON p.id = f.photo_id AND p.missing = 0
       WHERE f.kind = 'pet' GROUP BY f.label`
    ).all();
  }
  res.json({ named, groups, pets });
});

app.get('/api/names', (req, res) => {
  const kind = req.query.kind === 'pet' ? 'pet' : 'person';
  res.json(db.prepare('SELECT id, name FROM persons WHERE kind = ? ORDER BY name').all(kind));
});

app.get('/api/group/:id', (req, res) => {
  const cl = db.prepare('SELECT * FROM clusters WHERE id = ?').get(Number(req.params.id));
  if (!cl) return res.status(404).json({ error: 'Not found' });
  const faces = db
    .prepare(
      `SELECT f.id, f.photo_id FROM faces f JOIN photos p ON p.id = f.photo_id AND p.missing = 0
       WHERE f.cluster_id = ? AND f.person_id IS NULL ORDER BY f.score * f.w DESC LIMIT 300`
    )
    .all(cl.id);
  res.json({ id: cl.id, kind: cl.kind, faces });
});

app.post('/api/group/:id/name', (req, res) => {
  const cl = db.prepare('SELECT * FROM clusters WHERE id = ?').get(Number(req.params.id));
  if (!cl) return res.status(404).json({ error: 'Not found' });
  const person = findOrCreatePerson(req.body?.name, cl.kind === 'pet' ? 'pet' : 'person');
  tx(db, () => assignCluster(cl.id, person.id));
  clustersChanged();
  res.json({ person: personSummary(person) });
});

app.post('/api/group/:id/ignore', (req, res) => {
  db.prepare('UPDATE clusters SET ignored = 1 WHERE id = ?').run(Number(req.params.id));
  res.json({ ok: true });
});

app.get('/api/person/:id', (req, res) => {
  const p = db.prepare('SELECT * FROM persons WHERE id = ?').get(Number(req.params.id));
  if (!p) return res.status(404).json({ error: 'Not found' });
  res.json(personSummary(p));
});

app.get('/api/person/:id/faces', (req, res) => {
  const offset = Math.max(0, Number(req.query.offset) || 0);
  res.json(
    db
      .prepare(
        `SELECT f.id, f.photo_id, f.confirmed FROM faces f JOIN photos p ON p.id = f.photo_id AND p.missing = 0
         WHERE f.person_id = ? ORDER BY f.confirmed ASC, p.taken DESC LIMIT 300 OFFSET ?`
      )
      .all(Number(req.params.id), offset)
  );
});

// "Find more": look-alike groups that haven't been named yet, best match first.
app.get('/api/person/:id/suggestions', (req, res) => {
  const p = db.prepare('SELECT * FROM persons WHERE id = ?').get(Number(req.params.id));
  if (!p) return res.status(404).json({ error: 'Not found' });
  const kind = p.kind === 'pet' ? 'pet' : 'face';
  const centroid = personCentroid(db, p.id);
  if (!centroid) return res.json([]);
  const rejected = new Set(db.prepare('SELECT cluster_id FROM cluster_rejections WHERE person_id = ?').all(p.id).map((r) => r.cluster_id));
  const cands = [];
  for (const c of db.prepare('SELECT id, vsum FROM clusters WHERE kind = ? AND person_id IS NULL').all(kind)) {
    if (rejected.has(c.id)) continue;
    const s = dot(unit(fromBlob(c.vsum)), centroid);
    if (s >= SUGGEST_THRESHOLD[kind]) cands.push({ id: c.id, s });
  }
  cands.sort((a, b) => b.s - a.s);
  const out = [];
  for (const c of cands) {
    const faces = db
      .prepare(
        `SELECT f.id FROM faces f JOIN photos ph ON ph.id = f.photo_id AND ph.missing = 0
         WHERE f.cluster_id = ? AND f.person_id IS NULL
           AND f.id NOT IN (SELECT face_id FROM rejections WHERE person_id = ?)
         ORDER BY f.score * f.w DESC LIMIT 6`
      )
      .all(c.id, p.id)
      .map((r) => r.id);
    if (!faces.length) continue;
    const count = db.prepare('SELECT COUNT(*) n FROM faces WHERE cluster_id = ? AND person_id IS NULL').get(c.id).n;
    out.push({ group: c.id, similarity: Math.round(c.s * 100) / 100, count, faces });
    if (out.length >= 24) break;
  }
  res.json(out);
});

app.post('/api/person/:id/accept', (req, res) => {
  const pid = Number(req.params.id);
  const gid = Number(req.body?.group);
  tx(db, () => assignCluster(gid, pid));
  clustersChanged();
  res.json({ ok: true });
});
app.post('/api/person/:id/reject', (req, res) => {
  db.prepare('INSERT OR IGNORE INTO cluster_rejections (cluster_id, person_id) VALUES (?, ?)').run(Number(req.body?.group), Number(req.params.id));
  res.json({ ok: true });
});

app.post('/api/person/:id/rename', (req, res) => {
  const p = db.prepare('SELECT * FROM persons WHERE id = ?').get(Number(req.params.id));
  if (!p) return res.status(404).json({ error: 'Not found' });
  const name = String(req.body?.name || '').trim().replace(/\s+/g, ' ');
  if (!name) return res.status(400).json({ error: 'Please type a name' });
  const other = db.prepare('SELECT * FROM persons WHERE lower(name) = lower(?) AND kind = ? AND id != ?').get(name, p.kind, p.id);
  if (other) {
    // Same name as someone existing: merge the two.
    tx(db, () => {
      db.prepare('UPDATE faces SET person_id = ? WHERE person_id = ?').run(other.id, p.id);
      db.prepare('UPDATE clusters SET person_id = ? WHERE person_id = ?').run(other.id, p.id);
      db.prepare('UPDATE OR IGNORE rejections SET person_id = ? WHERE person_id = ?').run(other.id, p.id);
      db.prepare('UPDATE OR IGNORE cluster_rejections SET person_id = ? WHERE person_id = ?').run(other.id, p.id);
      db.prepare('DELETE FROM persons WHERE id = ?').run(p.id);
    });
    clustersChanged();
    return res.json({ merged: true, person: personSummary(other) });
  }
  db.prepare('UPDATE persons SET name = ? WHERE id = ?').run(name, p.id);
  searcher.clearCache();
  res.json({ person: personSummary({ ...p, name }) });
});

app.post('/api/person/:id/cover', (req, res) => {
  db.prepare('UPDATE persons SET cover_face_id = ? WHERE id = ?').run(Number(req.body?.face), Number(req.params.id));
  res.json({ ok: true });
});

app.delete('/api/person/:id', (req, res) => {
  const id = Number(req.params.id);
  tx(db, () => {
    db.prepare('UPDATE faces SET person_id = NULL, confirmed = 0 WHERE person_id = ?').run(id);
    db.prepare('UPDATE clusters SET person_id = NULL WHERE person_id = ?').run(id);
    db.prepare('DELETE FROM persons WHERE id = ?').run(id);
  });
  clustersChanged();
  res.json({ ok: true });
});

// ----- print list: gather photos, then copy them to one folder for the print shop -----
app.post('/api/print/:id', (req, res) => {
  const id = Number(req.params.id);
  if (req.body?.value) db.prepare('INSERT OR IGNORE INTO print_list (photo_id, added) VALUES (?, ?)').run(id, Date.now());
  else db.prepare('DELETE FROM print_list WHERE photo_id = ?').run(id);
  res.json({ count: db.prepare('SELECT COUNT(*) n FROM print_list').get().n });
});
app.get('/api/print', (req, res) => {
  res.json({ count: db.prepare('SELECT COUNT(*) n FROM print_list').get().n });
});
app.post('/api/print-clear', (req, res) => {
  db.prepare('DELETE FROM print_list').run();
  res.json({ ok: true });
});
app.post('/api/print-export', asyncRoute(async (req, res) => {
  const rows = db.prepare('SELECT p.path, p.filename FROM print_list l JOIN photos p ON p.id = l.photo_id ORDER BY p.taken').all();
  if (!rows.length) return res.status(400).json({ error: 'The print list is empty.' });
  const today = new Date();
  const stamp = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  let dest = path.join(await getDesktop(), 'Photos to print', stamp);
  for (let n = 2; fs.existsSync(dest); n++) dest = path.join(await getDesktop(), 'Photos to print', `${stamp} (${n})`);
  fs.mkdirSync(dest, { recursive: true });
  let copied = 0;
  const failed = [];
  for (const r of rows) {
    // Copies only — the originals are never moved or changed.
    const ext = path.extname(r.filename);
    const stem = path.basename(r.filename, ext);
    let target = path.join(dest, r.filename);
    for (let n = 2; fs.existsSync(target); n++) target = path.join(dest, `${stem} (${n})${ext}`);
    try {
      await fs.promises.copyFile(r.path, target, fs.constants.COPYFILE_EXCL);
      copied++;
    } catch {
      failed.push(r.filename);
    }
  }
  explorer(`"${dest}"`);
  res.json({ folder: dest, copied, failed });
}));

app.use((req, res) => res.status(404).json({ error: 'Not found' }));
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (!err.status || err.status >= 500) log('Request failed', req.method, req.url, err);
  res.status(err.status && err.status < 500 ? err.status : 500).json({ error: err.userMessage || (err.status && err.status < 500 ? 'Bad request' : 'Something went wrong') });
});

// ---------- start ----------
const server = app.listen(PORT, '127.0.0.1', () => {
  log(`Family Photos running at ${URL_BASE}`);
  // Basic facts about this PC, so a shared log makes sense on its own.
  const folders = db.prepare('SELECT path FROM folders').all().map((r) => r.path);
  const photos = db.prepare('SELECT COUNT(*) n FROM photos WHERE missing = 0').get().n;
  log(
    `Windows ${os.release()}, Node ${process.version}, ${os.cpus().length} CPUs, ${Math.round(os.totalmem() / 2 ** 30)} GB memory.`,
    `${photos} photos known. Folders: ${folders.join(' ; ') || '(none yet)'}`
  );
  startIndexer();
  if (!NO_BROWSER) openBrowser();
});
server.on('error', (e) => {
  log('Server could not start:', e.message);
  if (e.code === 'EADDRINUSE' && !NO_BROWSER) openBrowser();
  process.exit(1);
});
const shutdown = () => {
  indexer?.removeAllListeners('exit');
  indexer?.kill();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
