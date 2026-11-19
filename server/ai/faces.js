// Face detection (SCRFD) and face recognition (ArcFace) from InsightFace's
// "buffalo_s" pack, run on the CPU with ONNX Runtime.
import path from 'node:path';
import ort from 'onnxruntime-node';
import { MODEL_DIR } from '../paths.js';

const DET_SIZE = 640;
const DET_THRESHOLD = 0.6;
const NMS_THRESHOLD = 0.4;
// Smaller faces are mostly background people. Relative to the image so it works the
// same on full photos (36px at 1600px) and on OneDrive/iCloud previews (768px).
const MIN_FACE_FRACTION = 0.0225;
const MIN_FACE_PX = 20;

// Where ArcFace expects the eyes, nose and mouth corners in its 112x112 input.
const ARCFACE_DST = [
  [38.2946, 51.6963],
  [73.5318, 51.5014],
  [56.0252, 71.7366],
  [41.5493, 92.3655],
  [70.7299, 92.2041],
];

let det;
let rec;

export async function loadFaceModels(threads = 3) {
  const opts = { intraOpNumThreads: threads, interOpNumThreads: 1, graphOptimizationLevel: 'all' };
  det ??= await ort.InferenceSession.create(path.join(MODEL_DIR, 'faces', 'det_500m.onnx'), opts);
  rec ??= await ort.InferenceSession.create(path.join(MODEL_DIR, 'faces', 'w600k_mbf.onnx'), opts);
}

function iou(a, b) {
  const x1 = Math.max(a.x1, b.x1);
  const y1 = Math.max(a.y1, b.y1);
  const x2 = Math.min(a.x2, b.x2);
  const y2 = Math.min(a.y2, b.y2);
  const inter = Math.max(0, x2 - x1 + 1) * Math.max(0, y2 - y1 + 1);
  const areaA = (a.x2 - a.x1 + 1) * (a.y2 - a.y1 + 1);
  const areaB = (b.x2 - b.x1 + 1) * (b.y2 - b.y1 + 1);
  return inter / (areaA + areaB - inter);
}

async function detect(img) {
  const { data, width, height } = img;
  const scale = Math.min(DET_SIZE / width, DET_SIZE / height);
  const nw = Math.round(width * scale);
  const nh = Math.round(height * scale);

  // Nearest-neighbour resize into a zero-padded 640x640 planar tensor, normalised.
  const plane = DET_SIZE * DET_SIZE;
  const input = new Float32Array(3 * plane);
  input.fill(-127.5 / 128); // black padding, normalised (as InsightFace does)
  for (let y = 0; y < nh; y++) {
    const sy = Math.min(height - 1, Math.floor((y + 0.5) / scale));
    for (let x = 0; x < nw; x++) {
      const sx = Math.min(width - 1, Math.floor((x + 0.5) / scale));
      const si = (sy * width + sx) * 3;
      const di = y * DET_SIZE + x;
      input[di] = (data[si] - 127.5) / 128;
      input[plane + di] = (data[si + 1] - 127.5) / 128;
      input[2 * plane + di] = (data[si + 2] - 127.5) / 128;
    }
  }
  const out = await det.run({ [det.inputNames[0]]: new ort.Tensor('float32', input, [1, 3, DET_SIZE, DET_SIZE]) });
  const names = det.outputNames;

  const cands = [];
  [8, 16, 32].forEach((stride, i) => {
    const scores = out[names[i]].data;
    const boxes = out[names[i + 3]].data;
    const kps = out[names[i + 6]].data;
    const fw = DET_SIZE / stride;
    for (let a = 0; a < scores.length; a++) {
      if (scores[a] < DET_THRESHOLD) continue;
      const cell = a >> 1; // 2 anchors per location
      const cx = (cell % fw) * stride;
      const cy = Math.floor(cell / fw) * stride;
      const box = {
        score: scores[a],
        x1: (cx - boxes[a * 4] * stride) / scale,
        y1: (cy - boxes[a * 4 + 1] * stride) / scale,
        x2: (cx + boxes[a * 4 + 2] * stride) / scale,
        y2: (cy + boxes[a * 4 + 3] * stride) / scale,
        kps: [],
      };
      for (let k = 0; k < 5; k++) {
        box.kps.push([(cx + kps[a * 10 + k * 2] * stride) / scale, (cy + kps[a * 10 + k * 2 + 1] * stride) / scale]);
      }
      cands.push(box);
    }
  });

  cands.sort((p, q) => q.score - p.score);
  const keep = [];
  for (const c of cands) if (keep.every((k) => iou(k, c) <= NMS_THRESHOLD)) keep.push(c);
  return keep;
}

// Least-squares similarity transform (rotation + uniform scale + shift) from src to dst points.
function similarity(src, dst) {
  const n = src.length;
  let sx = 0, sy = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) {
    sx += src[i][0]; sy += src[i][1]; dx += dst[i][0]; dy += dst[i][1];
  }
  sx /= n; sy /= n; dx /= n; dy /= n;
  let num1 = 0, num2 = 0, den = 0;
  for (let i = 0; i < n; i++) {
    const ax = src[i][0] - sx, ay = src[i][1] - sy;
    const bx = dst[i][0] - dx, by = dst[i][1] - dy;
    num1 += ax * bx + ay * by;
    num2 += ax * by - ay * bx;
    den += ax * ax + ay * ay;
  }
  const a = num1 / den;
  const b = num2 / den;
  // x' = a x - b y + tx ; y' = b x + a y + ty
  return { a, b, tx: dx - (a * sx - b * sy), ty: dy - (b * sx + a * sy) };
}

function alignedFace(img, kps) {
  const { data, width, height } = img;
  const { a, b, tx, ty } = similarity(kps, ARCFACE_DST);
  // Inverse mapping: for each output pixel find its source location.
  const det2 = a * a + b * b;
  const ia = a / det2;
  const ib = b / det2;
  const S = 112;
  const plane = S * S;
  const out = new Float32Array(3 * plane);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const u = x - tx;
      const v = y - ty;
      const srcX = ia * u + ib * v;
      const srcY = -ib * u + ia * v;
      const x0 = Math.floor(srcX), y0 = Math.floor(srcY);
      const fx = srcX - x0, fy = srcY - y0;
      const di = y * S + x;
      for (let c = 0; c < 3; c++) {
        const px = (xx, yy) =>
          xx < 0 || yy < 0 || xx >= width || yy >= height ? 0 : data[(yy * width + xx) * 3 + c];
        const val =
          px(x0, y0) * (1 - fx) * (1 - fy) +
          px(x0 + 1, y0) * fx * (1 - fy) +
          px(x0, y0 + 1) * (1 - fx) * fy +
          px(x0 + 1, y0 + 1) * fx * fy;
        out[c * plane + di] = (val - 127.5) / 127.5;
      }
    }
  }
  return out;
}

export function normalize(v) {
  let s = 0;
  for (let i = 0; i < v.length; i++) s += v[i] * v[i];
  s = Math.sqrt(s) || 1;
  const o = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) o[i] = v[i] / s;
  return o;
}

/** Detect faces in an RGB image and return boxes (as fractions) with 512-d embeddings. */
export async function findFaces(img) {
  const minSide = Math.max(MIN_FACE_PX, MIN_FACE_FRACTION * Math.max(img.width, img.height));
  const boxes = (await detect(img)).filter((b) => Math.min(b.x2 - b.x1, b.y2 - b.y1) >= minSide);
  const faces = [];
  for (const b of boxes) {
    const input = alignedFace(img, b.kps);
    const r = await rec.run({ [rec.inputNames[0]]: new ort.Tensor('float32', input, [1, 3, 112, 112]) });
    const emb = normalize(r[rec.outputNames[0]].data);
    const x1 = Math.max(0, b.x1), y1 = Math.max(0, b.y1);
    const x2 = Math.min(img.width, b.x2), y2 = Math.min(img.height, b.y2);
    faces.push({
      x: x1 / img.width,
      y: y1 / img.height,
      w: (x2 - x1) / img.width,
      h: (y2 - y1) / img.height,
      score: b.score,
      emb,
    });
  }
  return faces;
}
