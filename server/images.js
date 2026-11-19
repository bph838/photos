// Reading images. Originals are only ever opened for reading.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import sharp from 'sharp';
import { thumbPath, cropPath } from './paths.js';

sharp.cache(false);
sharp.concurrency(2);

export const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.tif', '.tiff', '.heic', '.heif', '.avif']);

export function isHeic(p) {
  const e = path.extname(p).toLowerCase();
  return e === '.heic' || e === '.heif';
}

let heicDecode;
async function decodeHeic(file) {
  heicDecode ??= (await import('heic-decode')).default;
  const buffer = await fs.promises.readFile(file);
  const { width, height, data } = await heicDecode({ buffer });
  return sharp(Buffer.from(data.buffer, data.byteOffset, data.byteLength), { raw: { width, height, channels: 4 } });
}

/** A sharp pipeline for the photo, upright according to its EXIF orientation. */
export async function openImage(file) {
  if (isHeic(file)) return decodeHeic(file);
  return sharp(file, { failOn: 'none', limitInputPixels: 300_000_000 }).rotate();
}

export async function makeThumb(id, file) {
  const out = thumbPath(id);
  if (fs.existsSync(out)) return out;
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const img = await openImage(file);
  const tmp = `${out}.${process.pid}.tmp`;
  await img.resize(400, 400, { fit: 'inside', withoutEnlargement: true }).webp({ quality: 72 }).toFile(tmp);
  fs.renameSync(tmp, out);
  return out;
}

/**
 * Thumbnail for a cloud-only (OneDrive/iCloud) photo, from the preview Windows gives us,
 * without downloading the photo. Returns { width, height } of the preview, or null.
 */
export async function makeCloudThumb(id, file, shell) {
  const out = thumbPath(id);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const png = `${out}.${process.pid}.png`;
  try {
    if (!(await shell.thumbnail(file, png))) return null;
    const img = sharp(png).removeAlpha();
    const meta = await img.metadata();
    const tmp = `${out}.${process.pid}.tmp`;
    await img.resize(400, 400, { fit: 'inside', withoutEnlargement: true }).webp({ quality: 72 }).toFile(tmp);
    fs.renameSync(tmp, out);
    return { width: meta.width, height: meta.height };
  } finally {
    fs.rmSync(png, { force: true });
  }
}

/**
 * RGB pixels of a cloud-only photo's preview (about 768px), for the AI.
 * Comes from Windows' thumbnail cache / the sync app: the photo is not downloaded.
 */
export async function loadCloudRgb(file, shell) {
  const png = path.join(os.tmpdir(), `familyphotos-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.png`);
  try {
    if (!(await shell.thumbnail(file, png))) throw new Error('No preview available from OneDrive/iCloud');
    const { data, info } = await sharp(png).removeAlpha().toColourspace('srgb').raw().toBuffer({ resolveWithObject: true });
    return { data, width: info.width, height: info.height };
  } finally {
    fs.rmSync(png, { force: true });
  }
}

/** A large but browser-friendly version for the viewer (handles HEIC/TIFF too). */
export async function makeDisplay(file, maxSide = 2400) {
  const img = await openImage(file);
  return img.resize(maxSide, maxSide, { fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 88 }).toBuffer();
}

/** Decoded RGB pixels, longest side <= maxSide. Used by the AI. */
export async function loadRgb(file, maxSide = 1600) {
  const img = await openImage(file);
  const { data, info } = await img
    .resize(maxSide, maxSide, { fit: 'inside', withoutEnlargement: true })
    .removeAlpha()
    .toColourspace('srgb')
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

/** Square crop around a face/pet box, cached on disk. */
export async function makeCrop(face, file) {
  const out = cropPath(face.id);
  if (fs.existsSync(out)) return out;
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const img = await openImage(file);
  const { data, info } = await img
    .resize(2000, 2000, { fit: 'inside', withoutEnlargement: true })
    .raw()
    .toBuffer({ resolveWithObject: true });
  const W = info.width;
  const H = info.height;
  const cx = (face.x + face.w / 2) * W;
  const cy = (face.y + face.h / 2) * H;
  let side = Math.max(face.w * W, face.h * H) * (face.kind === 'face' ? 1.6 : 1.15);
  side = Math.min(side, W, H);
  const left = Math.round(Math.min(Math.max(cx - side / 2, 0), W - side));
  const top = Math.round(Math.min(Math.max(cy - side / 2, 0), H - side));
  const s = Math.max(1, Math.floor(side));
  const tmp = `${out}.${process.pid}.tmp`;
  await sharp(data, { raw: { width: W, height: H, channels: info.channels } })
    .extract({ left, top, width: Math.min(s, W - left), height: Math.min(s, H - top) })
    .resize(200, 200, { fit: 'cover' })
    .webp({ quality: 80 })
    .toFile(tmp);
  fs.renameSync(tmp, out);
  return out;
}
