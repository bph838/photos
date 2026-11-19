// Downloads the AI models once, so the app then works fully offline.
import fs from 'node:fs';
import path from 'node:path';
import AdmZip from 'adm-zip';
import { fileURLToPath } from 'node:url';
import { MODEL_DIR } from './paths.js';

const FACE_ZIP = 'https://github.com/deepinsight/insightface/releases/download/v0.7/buffalo_s.zip';
const FACE_FILES = ['det_500m.onnx', 'w600k_mbf.onnx'];

export async function ensureFaceModels(say = console.log) {
  const dir = path.join(MODEL_DIR, 'faces');
  if (FACE_FILES.every((f) => fs.existsSync(path.join(dir, f)))) return;
  fs.mkdirSync(dir, { recursive: true });
  say('Downloading face recognition models (about 125 MB)...');
  const res = await fetch(FACE_ZIP);
  if (!res.ok) throw new Error(`Download failed: ${res.status} ${res.statusText}`);
  const zip = new AdmZip(Buffer.from(await res.arrayBuffer()));
  for (const f of FACE_FILES) {
    const entry = zip.getEntry(f);
    if (!entry) throw new Error(`${f} missing from model pack`);
    fs.writeFileSync(path.join(dir, f), entry.getData());
  }
}

export async function ensureAllModels(say = console.log) {
  await ensureFaceModels(say);
  const clip = await import('./ai/clip.js');
  say('Downloading photo search model (about 150 MB)...');
  await clip.loadVision(2);
  await clip.loadText(2);
  say('Downloading pet detection model (about 45 MB)...');
  await clip.loadDetector(2);
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
