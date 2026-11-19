// Groups similar faces (and pets) together so a whole group can be named at once.
import { fromBlob, toBlob } from './db.js';

export const JOIN_THRESHOLD = { face: 0.48, pet: 0.88 };
export const SUGGEST_THRESHOLD = { face: 0.3, pet: 0.82 };

export function dot(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}
export function unit(v) {
  let s = 0;
  for (let i = 0; i < v.length; i++) s += v[i] * v[i];
  s = Math.sqrt(s) || 1;
  const o = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) o[i] = v[i] / s;
  return o;
}

/** In-memory index of cluster centroids, used by the indexer. */
export class ClusterIndex {
  constructor(db) {
    this.db = db;
    this.dirty = true;
  }
  load() {
    this.byKind = { face: [], pet: [] };
    for (const r of this.db.prepare('SELECT id, kind, person_id, vsum, count FROM clusters').all()) {
      const vsum = fromBlob(r.vsum);
      this.byKind[r.kind]?.push({ id: r.id, person_id: r.person_id, vsum, count: r.count, c: unit(vsum) });
    }
    this.dirty = false;
  }
  /** Put an embedding into the best matching cluster (or a new one). Returns the cluster. */
  assign(kind, emb) {
    if (this.dirty) this.load();
    const list = this.byKind[kind];
    let best = null;
    let bestSim = -1;
    for (const cl of list) {
      const s = dot(cl.c, emb);
      if (s > bestSim) {
        bestSim = s;
        best = cl;
      }
    }
    if (best && bestSim >= JOIN_THRESHOLD[kind]) {
      for (let i = 0; i < emb.length; i++) best.vsum[i] += emb[i];
      best.count++;
      best.c = unit(best.vsum);
      this.db.prepare('UPDATE clusters SET vsum = ?, count = ? WHERE id = ?').run(toBlob(best.vsum), best.count, best.id);
      return best;
    }
    const vsum = Float32Array.from(emb);
    const r = this.db.prepare('INSERT INTO clusters (kind, vsum, count) VALUES (?, ?, 1)').run(kind, toBlob(vsum));
    const cl = { id: Number(r.lastInsertRowid), person_id: null, vsum, count: 1, c: unit(vsum) };
    list.push(cl);
    return cl;
  }
}

/** Remove one face's embedding from its cluster's running sum. */
export function detachFromCluster(db, face) {
  if (!face.cluster_id) return;
  const cl = db.prepare('SELECT vsum, count FROM clusters WHERE id = ?').get(face.cluster_id);
  if (!cl) return;
  if (cl.count <= 1) {
    db.prepare('DELETE FROM clusters WHERE id = ?').run(face.cluster_id);
  } else {
    const v = fromBlob(cl.vsum);
    const e = fromBlob(face.emb);
    for (let i = 0; i < v.length; i++) v[i] -= e[i];
    db.prepare('UPDATE clusters SET vsum = ?, count = ? WHERE id = ?').run(toBlob(v), cl.count - 1, face.cluster_id);
  }
  db.prepare('UPDATE faces SET cluster_id = NULL WHERE id = ?').run(face.id);
}

/** Average embedding of everything tagged as this person/pet. */
export function personCentroid(db, personId) {
  const rows = db.prepare('SELECT emb FROM faces WHERE person_id = ? AND emb IS NOT NULL').all(personId);
  if (!rows.length) return null;
  let sum = null;
  for (const r of rows) {
    const e = fromBlob(r.emb);
    if (!sum) sum = new Float32Array(e.length);
    for (let i = 0; i < e.length; i++) sum[i] += e[i];
  }
  return unit(sum);
}
