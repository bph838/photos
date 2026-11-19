// Turns byte counts from downloads into friendly progress messages.

export const mb = (bytes) => (bytes / 1048576).toFixed(bytes < 10 * 1048576 ? 1 : 0);

export function progressText(label, loaded, total) {
  if (!total) return `${label}: ${mb(loaded)} MB`;
  return `${label}: ${mb(loaded)} of ${mb(total)} MB (${Math.floor((100 * loaded) / total)}%)`;
}

/**
 * A progress_callback for transformers.js. A model is several files downloaded
 * one after another, so we add them up. Calls say(message, { done, total })
 * at most a few times a second.
 */
export function downloadTracker(label, say) {
  const files = new Map();
  let last = 0;
  return (e) => {
    // Skip small config files: they finish instantly and would just flash "100%".
    if (e?.status !== 'progress' || !e.file || !e.total || e.total < 1048576) return;
    files.set(e.file, { loaded: Math.min(e.loaded ?? 0, e.total), total: e.total });
    let loaded = 0;
    let total = 0;
    for (const f of files.values()) {
      loaded += f.loaded;
      total += f.total;
    }
    const now = Date.now();
    if (now - last < 400 && loaded < total) return;
    last = now;
    say(progressText(label, loaded, total), { done: loaded, total });
  };
}

/** Console reporter for the command-line setup: rewrites one line in place. */
let lastLog = 0;
export function consoleSay(msg, p) {
  const finished = !p || p.done >= p.total;
  if (p && process.stdout.isTTY) {
    process.stdout.write(`\r  ${msg}`.padEnd(80) + (finished ? '\n' : ''));
  } else if (finished || Date.now() - lastLog > 5000) {
    lastLog = Date.now();
    console.log(`  ${msg}`);
  }
}
