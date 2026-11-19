// Downloads the AI models once, so the app then works fully offline.
// say(message, progress?) is called with { done, total } in bytes while downloading.
import fs from 'node:fs';
import path from 'node:path';
import AdmZip from 'adm-zip';
import { fileURLToPath } from 'node:url';
import { MODEL_DIR } from './paths.js';
import { progressText, downloadTracker, consoleSay } from './progress.js';

const FACE_ZIP = 'https://github.com/deepinsight/insightface/releases/download/v0.7/buffalo_s.zip';
const FACE_FILES = ['det_500m.onnx', 'w600k_mbf.onnx'];
const STALL_MS = 60_000;

/** Download into memory, reporting progress; gives up if no data arrives for a minute. */
async function download(url, label, say) {
  const ctrl = new AbortController();
  let stall = setTimeout(() => ctrl.abort(), STALL_MS);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`Download failed: ${res.status} ${res.statusText}`);
    const total = Number(res.headers.get('content-length')) || 0;
    const chunks = [];
    let done = 0;
    let last = 0;
    say(progressText(label, 0, total), { done: 0, total });
    for await (const chunk of res.body) {
      clearTimeout(stall);
      stall = setTimeout(() => ctrl.abort(), STALL_MS);
      chunks.push(chunk);
      done += chunk.length;
      if (Date.now() - last > 400) {
        last = Date.now();
        say(progressText(label, done, total), { done, total: total || done });
      }
    }
    say(progressText(label, done, total || done), { done, total: total || done });
    return Buffer.concat(chunks);
  } catch (e) {
    if (ctrl.signal.aborted) throw new Error('The download stopped (no data for a minute). Please check the internet connection.');
    throw e;
  } finally {
    clearTimeout(stall);
  }
}

export async function ensureFaceModels(say = consoleSay) {
  const dir = path.join(MODEL_DIR, 'faces');
  if (FACE_FILES.every((f) => fs.existsSync(path.join(dir, f)))) return;
  fs.mkdirSync(dir, { recursive: true });
  const zip = new AdmZip(await download(FACE_ZIP, 'Downloading face recognition models', say));
  say('Unpacking face recognition models...');
  for (const f of FACE_FILES) {
    const entry = zip.getEntry(f);
    if (!entry) throw new Error(`${f} missing from model pack`);
    fs.writeFileSync(path.join(dir, f), entry.getData());
  }
}

export async function ensureAllModels(say = consoleSay) {
  await ensureFaceModels(say);
  const clip = await import('./ai/clip.js');
  // Progress lines only appear if something actually needs downloading.
  const searchProgress = downloadTracker('Downloading photo search model', say);
  await clip.loadVision(2, searchProgress);
  await clip.loadText(2, searchProgress);
  await clip.loadDetector(2, downloadTracker('Downloading pet finder model', say));
  say('All models ready.');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  ensureAllModels().then(
    () => process.exit(0),
    (e) => {
      console.error('Model setup failed:', e.message);
      process.exit(1);
    }
  );
}
