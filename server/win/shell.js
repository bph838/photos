// Node side of shell-helper.ps1: asks Windows (not the photo file) for file
// attributes and thumbnails, so OneDrive/iCloud "cloud-only" photos can be shown
// without being downloaded. On other systems everything is treated as local.
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import readline from 'node:readline';
import { APP_ROOT, log } from '../paths.js';

// FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS | RECALL_ON_OPEN | OFFLINE: reading it would download it.
const CLOUD_BITS = 0x400000 | 0x40000 | 0x1000;
export const isCloudOnly = (attrs) => attrs != null && attrs >= 0 && (attrs & CLOUD_BITS) !== 0;

const SIIGBF_BIGGERSIZEOK = 0x1;
const SIIGBF_THUMBNAILONLY = 0x8;
const SIIGBF_INCACHEONLY = 0x10;
const E_PENDING = 'err 8004B205'; // the sync app is still fetching the preview

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Helper {
  constructor() {
    this.queue = [];
    this.busy = false;
    this.proc = null;
    this.ready = null;
  }

  start() {
    if (this.proc) return this.ready;
    const script = path.join(APP_ROOT, 'server', 'win', 'shell-helper.ps1');
    const proc = spawn('powershell.exe', ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-File', script], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.proc = proc;
    const rl = readline.createInterface({ input: proc.stdout });
    let onLine = null;
    this.ready = new Promise((resolve, reject) => {
      onLine = (l) => (l === 'ready' ? resolve() : reject(new Error(l)));
      proc.once('exit', () => reject(new Error('Windows helper could not start')));
    });
    rl.on('line', (l) => {
      const cb = onLine;
      onLine = null;
      cb?.(l);
    });
    this.setLineHandler = (fn) => (onLine = fn);
    let err = '';
    proc.stderr.on('data', (d) => (err += d).length > 4000 && (err = err.slice(-4000)));
    proc.on('exit', (code) => {
      if (code) log('Windows helper stopped', code, err.trim());
      this.proc = null;
      this.pending?.reject(new Error('Windows helper stopped'));
    });
    proc.stdin.on('error', () => {});
    return this.ready;
  }

  /** Send one request line; resolves with the reply line. Requests run one at a time. */
  request(line) {
    return new Promise((resolve, reject) => {
      this.queue.push({ line, resolve, reject });
      this.pump();
    });
  }

  async pump() {
    if (this.busy) return;
    const job = this.queue.shift();
    if (!job) return;
    this.busy = true;
    try {
      await this.start();
      const reply = await new Promise((resolve, reject) => {
        this.pending = { reject };
        const timer = setTimeout(() => {
          reject(new Error('Windows helper timed out'));
          this.proc?.kill();
        }, 60000);
        this.setLineHandler((l) => {
          clearTimeout(timer);
          resolve(l);
        });
        this.proc.stdin.write(job.line + '\n');
      });
      job.resolve(reply);
    } catch (e) {
      job.reject(e);
    } finally {
      this.pending = null;
      this.busy = false;
      this.pump();
    }
  }

  stop() {
    this.proc?.stdin.end();
  }
}

export class Shell {
  constructor(size = 1) {
    this.enabled = process.platform === 'win32';
    this.helpers = Array.from({ length: size }, () => new Helper());
    this.turn = 0;
  }
  pick() {
    this.turn = (this.turn + 1) % this.helpers.length;
    return this.helpers[this.turn];
  }

  /** File attributes for many paths (null entries if unknown). Never opens the files. */
  async attributes(paths) {
    if (!this.enabled || !paths.length) return paths.map(() => null);
    const out = [];
    for (let i = 0; i < paths.length; i += 200) {
      const chunk = paths.slice(i, i + 200);
      try {
        const reply = await this.pick().request(`A\t${chunk.join('\t')}`);
        const nums = reply.split(',').map(Number);
        chunk.forEach((_, k) => out.push(Number.isFinite(nums[k]) && nums[k] >= 0 ? nums[k] : null));
      } catch (e) {
        log('Could not read file attributes:', e.message);
        chunk.forEach(() => out.push(null));
      }
    }
    return out;
  }

  /**
   * Thumbnail from Windows (cache, or OneDrive/iCloud's own preview) saved as PNG.
   * Returns true on success. Does not download the photo.
   */
  async thumbnail(file, outPng, size = 768) {
    if (!this.enabled) return false;
    fs.mkdirSync(path.dirname(outPng), { recursive: true });
    const h = this.pick();
    let r = await h.request(`T\t${size}\t${SIIGBF_INCACHEONLY | SIIGBF_THUMBNAILONLY | SIIGBF_BIGGERSIZEOK}\t${file}\t${outPng}`);
    for (let tries = 0; r !== 'ok' && tries < 15; tries++) {
      r = await h.request(`T\t${size}\t${SIIGBF_THUMBNAILONLY | SIIGBF_BIGGERSIZEOK}\t${file}\t${outPng}`);
      if (r === E_PENDING) await sleep(700);
      else if (r !== 'ok') break;
    }
    return r === 'ok' && fs.existsSync(outPng);
  }

  stop() {
    this.helpers.forEach((h) => h.stop());
  }
}
