// CLIP: turns photos and text into comparable vectors, so "beach" or
// "birthday cake" can find photos without anyone tagging them.
import path from 'node:path';
import {
  env,
  AutoProcessor,
  AutoTokenizer,
  CLIPVisionModelWithProjection,
  CLIPTextModelWithProjection,
  RawImage,
  pipeline,
} from '@huggingface/transformers';
import { MODEL_DIR } from '../paths.js';
import { normalize } from './faces.js';

env.cacheDir = path.join(MODEL_DIR, 'hf');
env.allowLocalModels = false;
// After setup the models are on disk; only fetch if something is missing.
env.allowRemoteModels = true;

export const CLIP_ID = 'Xenova/clip-vit-base-patch32';
export const DETR_ID = 'Xenova/detr-resnet-50';

function sessionOptions(threads) {
  return { dtype: 'q8', device: 'cpu', session_options: { intraOpNumThreads: threads, interOpNumThreads: 1 } };
}

let vision, processor, text, tokenizer, detector;

export async function loadVision(threads = 3) {
  processor ??= await AutoProcessor.from_pretrained(CLIP_ID);
  vision ??= await CLIPVisionModelWithProjection.from_pretrained(CLIP_ID, sessionOptions(threads));
}
export async function loadText(threads = 2) {
  tokenizer ??= await AutoTokenizer.from_pretrained(CLIP_ID);
  text ??= await CLIPTextModelWithProjection.from_pretrained(CLIP_ID, sessionOptions(threads));
}
export async function loadDetector(threads = 3) {
  detector ??= await pipeline('object-detection', DETR_ID, sessionOptions(threads));
}

function toRaw(img) {
  return new RawImage(new Uint8ClampedArray(img.data.buffer, img.data.byteOffset, img.data.byteLength), img.width, img.height, 3);
}

/** img: { data: RGB bytes, width, height } */
export async function embedImage(img) {
  const inputs = await processor(toRaw(img));
  const { image_embeds } = await vision(inputs);
  return normalize(image_embeds.data);
}

export async function embedText(str) {
  const inputs = tokenizer([str], { padding: true, truncation: true });
  const { text_embeds } = await text(inputs);
  return normalize(text_embeds.data);
}

/** Returns [{ label, score, box: {xmin,ymin,xmax,ymax} in pixels }] for dogs and cats. */
export async function detectPets(img) {
  const res = await detector(toRaw(img), { threshold: 0.75 });
  return res.filter((r) => r.label === 'dog' || r.label === 'cat');
}

export function dot(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}
