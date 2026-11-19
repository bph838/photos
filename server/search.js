// Search: understands names of people/pets, years, folder/file names, and
// free-text descriptions ("beach", "birthday cake") via CLIP.
import { fromBlob } from './db.js';
import { dot } from './cluster.js';

const STOP = new Set(['and', 'with', 'or', 'the', 'a', 'an', 'of', 'in', 'at', 'on', 'photos', 'photo', 'pictures', 'picture', 'pics', 'me', 'show', 'find', '&', '+', ',']);
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

class ClipStore {
  constructor(db) {
    this.db = db;
    this.count = -1;
  }
  refresh() {
    const n = this.db.prepare('SELECT COUNT(*) n FROM photos WHERE clip IS NOT NULL').get().n;
    if (n === this.count) return;
    const rows = this.db.prepare('SELECT id, clip FROM photos WHERE clip IS NOT NULL AND missing = 0').all();
    this.ids = new Int32Array(rows.length);
    this.vecs = new Float32Array(rows.length * 512);
    rows.forEach((r, i) => {
      this.ids[i] = r.id;
      this.vecs.set(fromBlob(r.clip), i * 512);
    });
    this.count = n;
  }
  /** Map of photoId -> similarity for all indexed photos. */
  score(q) {
    this.refresh();
    const out = new Map();
    for (let i = 0; i < this.ids.length; i++) out.set(this.ids[i], dot(q, this.vecs.subarray(i * 512, i * 512 + 512)));
    return out;
  }
}

export class Searcher {
  constructor(db) {
    this.db = db;
    this.store = new ClipStore(db);
    this.clip = null;
    this.cache = new Map();
  }

  async embed(text) {
    if (!this.clip) {
      this.clip = await import('./ai/clip.js');
      await this.clip.loadText(2);
    }
    return this.clip.embedText(text);
  }

  /** Work out which words are names, years, etc. */
  parse(q) {
    let rest = ` ${q.toLowerCase().replace(/[’']s\b/g, '').replace(/\s+/g, ' ')} `;
    // Each matched name may belong to more than one entry (e.g. a person and a pet both called Lily).
    const byName = new Map();
    for (const p of this.db.prepare('SELECT id, name FROM persons ORDER BY length(name) DESC').all()) {
      const key = p.name.toLowerCase();
      if (!byName.has(key)) byName.set(key, { name: p.name, ids: [] });
      byName.get(key).ids.push(p.id);
    }
    const persons = [];
    for (const [key, entry] of byName) {
      const n = ` ${key} `;
      if (rest.includes(n)) {
        persons.push(entry);
        rest = rest.replace(n, ' ');
      }
    }
    let year = null;
    rest = rest.replace(/\b(19[5-9]\d|20\d\d)\b/, (m) => {
      year = Number(m);
      return ' ';
    });
    let month = null;
    for (let i = 0; i < 12; i++) {
      const re = new RegExp(`\\b(${MONTHS[i]}|${MONTHS[i].slice(0, 3)})\\b`);
      if (re.test(rest)) {
        month = i;
        rest = rest.replace(re, ' ');
        break;
      }
    }
    let pet = null;
    rest = rest.replace(/\b(dogs?|cats?|puppy|puppies|kitten|kittens)\b/, (m) => {
      pet = /^(dog|pupp)/.test(m) ? 'dog' : 'cat';
      return ' ';
    });
    const words = rest.split(' ').filter((w) => w && !STOP.has(w));
    return { persons, year, month, pet, text: words.join(' ') };
  }

  /** Returns { ids: ordered photo ids, understood: summary for the UI }. */
  async search(q) {
    const key = `${q}|${this.store.count}`;
    if (this.cache.has(key)) return this.cache.get(key);

    const p = this.parse(q);
    const where = ['p.missing = 0', 'p.thumb >= 0'];
    const args = [];
    for (const person of p.persons) {
      where.push(`EXISTS (SELECT 1 FROM faces f WHERE f.photo_id = p.id AND f.person_id IN (${person.ids.map(() => '?').join(',')}))`);
      args.push(...person.ids);
    }
    if (p.pet) {
      where.push("EXISTS (SELECT 1 FROM faces f WHERE f.photo_id = p.id AND f.kind = 'pet' AND f.label = ?)");
      args.push(p.pet);
    }
    if (p.year) {
      where.push("strftime('%Y', p.taken / 1000, 'unixepoch', 'localtime') = ?");
      args.push(String(p.year));
    }
    if (p.month !== null) {
      where.push("strftime('%m', p.taken / 1000, 'unixepoch', 'localtime') = ?");
      args.push(String(p.month + 1).padStart(2, '0'));
    }
    const rows = this.db.prepare(`SELECT p.id, p.path FROM photos p WHERE ${where.join(' AND ')} ORDER BY p.taken DESC`).all(...args);

    let ids;
    if (!p.text) {
      ids = rows.map((r) => r.id);
    } else {
      // 1) folder / file names containing all the words, e.g. "Spain" or "Christmas 2019"
      const words = p.text.split(' ');
      const byName = rows.filter((r) => {
        const lp = r.path.toLowerCase();
        return words.every((w) => lp.includes(w));
      });
      // 2) photos whose content matches the description
      const sims = this.store.score(await this.embed(`a photo of ${p.text}`));
      const scored = rows.filter((r) => sims.has(r.id)).map((r) => ({ id: r.id, s: sims.get(r.id) }));
      scored.sort((a, b) => b.s - a.s);
      const top = scored[0]?.s ?? 0;
      // Keep the photos close to the best match; looser when already filtered by people.
      const margin = p.persons.length || p.pet || p.year ? 0.07 : 0.05;
      const byContent = scored.filter((x) => x.s >= Math.max(0.19, top - margin)).slice(0, 1500);
      const seen = new Set();
      ids = [];
      for (const r of byName) if (!seen.has(r.id)) seen.add(r.id), ids.push(r.id);
      for (const r of byContent) if (!seen.has(r.id)) seen.add(r.id), ids.push(r.id);
    }

    const understood = [
      ...p.persons.map((x) => x.name),
      p.pet ? `${p.pet}s` : null,
      p.month !== null ? MONTHS[p.month][0].toUpperCase() + MONTHS[p.month].slice(1) : null,
      p.year,
      p.text ? `“${p.text}”` : null,
    ].filter(Boolean);
    const result = { ids, understood };
    this.cache.set(key, result);
    if (this.cache.size > 30) this.cache.delete(this.cache.keys().next().value);
    return result;
  }

  clearCache() {
    this.cache.clear();
  }
}
