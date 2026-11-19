// Family Photos — browser app (no build step, plain JavaScript).

// ---------------------------------------------------------------- helpers
const ICONS = {
  photos: '<rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="9" cy="9" r="2"/><path d="M21 15l-5-5L5 21"/>',
  people: '<circle cx="9" cy="8" r="4"/><path d="M2 21v-1a7 7 0 0 1 14 0v1"/><path d="M16 3.5a4 4 0 0 1 0 8M22 21v-1a7 7 0 0 0-4-6.3"/>',
  paw: '<circle cx="5.5" cy="10" r="2"/><circle cx="9.5" cy="5.5" r="2"/><circle cx="14.5" cy="5.5" r="2"/><circle cx="18.5" cy="10" r="2"/><path d="M12 11c-3 0-6 4.5-6 7a3 3 0 0 0 3 3c1.2 0 2-.6 3-.6s1.8.6 3 .6a3 3 0 0 0 3-3c0-2.5-3-7-6-7z"/>',
  heart: '<path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1-1.1a5.5 5.5 0 0 0-7.8 7.8l1 1.1L12 21l7.8-7.5 1-1.1a5.5 5.5 0 0 0 0-7.8z"/>',
  print: '<path d="M6 9V2h12v7"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/>',
  folder: '<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/>',
  open: '<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><path d="M15 3h6v6M10 14L21 3"/>',
  eye: '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>',
  refresh: '<path d="M23 4v6h-6M1 20v-6h6"/><path d="M3.5 9a9 9 0 0 1 14.9-3.4L23 10M1 14l4.6 4.4A9 9 0 0 0 20.5 15"/>',
  check: '<path d="M20 6L9 17l-5-5"/>',
  cloud: '<path d="M18 10h-1.3A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z"/>',
};
const icon = (name) => `<svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[name] || ''}</svg>`;
document.querySelectorAll('[data-icon]').forEach((el) => (el.innerHTML = icon(el.dataset.icon)));

/** Tiny element builder: h('div', {class: 'x', onclick}, child, 'text', ...) */
function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'html') el.innerHTML = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid instanceof Node ? kid : String(kid));
  return el;
}
const $ = (sel) => document.querySelector(sel);

const api = {
  async req(method, url, body) {
    const r = await fetch(url, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || 'Something went wrong');
    return data;
  },
  get: (u) => api.req('GET', u),
  post: (u, b = {}) => api.req('POST', u, b),
  del: (u) => api.req('DELETE', u),
};

let toastTimer;
function toast(msg, action) {
  const t = $('#toast');
  t.replaceChildren(msg);
  if (action) {
    t.append(' ', h('button', { class: 'btn small primary', style: { marginLeft: '10px' }, onclick: () => { t.hidden = true; action.run(); } }, action.label));
  }
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), action ? 8000 : 3500);
}
function fail(e) {
  toast(e.message || 'Something went wrong');
}

const LOCALE = navigator.language || 'en-GB';
const fmtMonth = (t) => new Date(t).toLocaleDateString(LOCALE, { month: 'long', year: 'numeric' });
const fmtLong = (t) =>
  new Date(t).toLocaleDateString(LOCALE, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }) +
  ', ' + new Date(t).toLocaleTimeString(LOCALE, { hour: 'numeric', minute: '2-digit' });
const plural = (n, word) => `${n.toLocaleString()} ${word}${n === 1 ? '' : 's'}`;
const thumbUrl = (id) => `/api/photo/${id}/thumb`;
const cloudName = (p) => (/onedrive/i.test(p) ? 'OneDrive' : /icloud/i.test(p) ? 'iCloud' : 'the cloud');
const cropUrl = (id) => `/api/face/${id}/crop`;

// ---------------------------------------------------------------- photo grid
// Loads photos page by page as you scroll; optionally grouped under month headings.
let renderGen = 0;
function photoGrid(container, query, { months = true, onTotal } = {}) {
  const gen = renderGen;
  const list = { items: [], total: null, done: false, loading: false, load };
  let grid = null;
  let monthKey = null;
  const sentinel = h('div', { class: 'more' });
  container.append(sentinel);

  function addTile(item, idx) {
    if (months) {
      const key = fmtMonth(item.taken);
      if (key !== monthKey) {
        monthKey = key;
        sentinel.before(h('div', { class: 'month' }, key));
        grid = null;
      }
    }
    if (!grid) {
      grid = h('div', { class: 'grid' });
      sentinel.before(grid);
    }
    const aspect = Math.min(3, Math.max(0.5, item.w && item.h ? item.w / item.h : 1.4));
    const tile = h(
      'div',
      {
        class: 'tile', tabindex: '0', role: 'button', 'aria-label': 'Open photo',
        style: { width: `${aspect * 190}px`, flexGrow: String(Math.round(aspect * 100)) },
        onclick: () => openViewer(list, idx),
        onkeydown: (e) => e.key === 'Enter' && openViewer(list, idx),
      },
      h('img', { src: thumbUrl(item.id), loading: 'lazy', alt: '', decoding: 'async' }),
      item.fav ? h('span', { class: 'fav', html: icon('heart') }) : null,
      item.cloud ? h('span', { class: 'cloud', title: 'Kept in the cloud: downloaded when opened', html: icon('cloud') }) : null
    );
    tile.dataset.id = item.id;
    grid.append(tile);
  }

  async function load() {
    if (list.loading || list.done) return;
    list.loading = true;
    try {
      const params = new URLSearchParams({ ...query, offset: list.items.length, limit: 200 });
      const r = await api.get(`/api/photos?${params}`);
      if (gen !== renderGen) return;
      list.total = r.total;
      onTotal?.(r);
      for (const it of r.items) addTile(it, list.items.push(it) - 1);
      list.done = list.items.length >= r.total || !r.items.length;
    } catch (e) {
      fail(e);
      list.done = true;
    } finally {
      list.loading = false;
    }
    if (!list.done && sentinel.getBoundingClientRect().top < innerHeight * 2) load();
  }
  const io = new IntersectionObserver((es) => es.some((e) => e.isIntersecting) && load(), { rootMargin: '1200px' });
  io.observe(sentinel);
  load();
  return list;
}

// ---------------------------------------------------------------- routing
const view = $('#view');
const routes = {};
function parseHash() {
  const [p, qs] = location.hash.replace(/^#\/?/, '').split('?');
  const parts = p.split('/').filter(Boolean);
  return { name: parts[0] || 'photos', arg: parts[1], params: Object.fromEntries(new URLSearchParams(qs || '')) };
}
async function render() {
  renderGen++;
  const r = parseHash();
  document.querySelectorAll('nav a').forEach((a) => a.classList.toggle('active', a.dataset.nav === r.name || (r.name === 'person' && a.dataset.nav === (r.params.kind === 'pet' ? 'pets' : 'people'))));
  if (r.name !== 'search') {
    $('#searchInput').value = '';
    $('#searchClear').hidden = true;
  }
  view.replaceChildren();
  view.scrollTop = 0;
  try {
    await (routes[r.name] || routes.photos)(r);
  } catch (e) {
    fail(e);
  }
}
addEventListener('hashchange', render);
const go = (hash) => (location.hash === hash ? render() : (location.hash = hash));

// ---------------------------------------------------------------- views
let lastStatus = null;

routes.photos = async ({ params }) => {
  const st = lastStatus || (await api.get('/api/status'));
  if (!st.folders) return renderWelcome();
  const years = await api.get('/api/years');
  view.append(h('h1', {}, params.year ? `Photos from ${params.year}` : 'All photos'));
  const chips = h('div', { class: 'chips' }, h('a', { class: `chip ${params.year ? '' : 'on'}`, href: '#/photos' }, 'All years'));
  for (const y of years) if (y.year) chips.append(h('a', { class: `chip ${params.year === y.year ? 'on' : ''}`, href: `#/photos?year=${y.year}`, title: plural(y.count, 'photo') }, y.year));
  view.append(chips);
  if (!years.length) {
    view.append(h('div', { class: 'empty' }, h('span', { class: 'big' }, '⏳'), 'Looking for your photos. They will appear here in a moment...'));
    return;
  }
  photoGrid(view, params.year ? { year: params.year } : {});
};

routes.search = async ({ params }) => {
  const q = params.q || '';
  $('#searchInput').value = q;
  $('#searchClear').hidden = !q;
  const head = h('h1', {}, 'Searching...');
  const line = h('p', { class: 'count-line' });
  view.append(head, line);
  photoGrid(view, { q }, {
    months: false,
    onTotal: (r) => {
      head.textContent = r.understood?.length ? r.understood.join(' · ') : `“${q}”`;
      line.textContent = r.total ? `${plural(r.total, 'photo')} found` : '';
      if (!r.total) {
        view.append(h('div', { class: 'empty' }, h('span', { class: 'big' }, '🔍'), 'No photos found. Try different words, or a name from the People page.'));
      }
      const st = lastStatus;
      if (st && st.analysed < st.total) {
        line.append(h('span', {}, ` — still looking through photos (${st.analysed.toLocaleString()} of ${st.total.toLocaleString()} done), so more may turn up later.`));
      }
    },
  });
};

routes.favourites = async () => {
  view.append(h('h1', {}, 'Favourites'), h('p', { class: 'sub' }, 'Photos you have marked with a heart.'));
  const list = photoGrid(view, { favorites: '1' }, {
    onTotal: (r) => !r.total && view.append(h('div', { class: 'empty' }, h('span', { class: 'big' }, '♡'), 'No favourites yet. Open a photo and press “Favourite”.')),
  });
  return list;
};

routes.print = async () => {
  const { count } = await api.get('/api/print');
  view.append(
    h('h1', {}, 'Print list'),
    h('p', { class: 'sub' }, 'Gather photos here, then copy them all into one folder on your Desktop, ready to take to the shop or put on a memory stick. Your original photos stay exactly where they are.')
  );
  if (!count) {
    view.append(h('div', { class: 'empty' }, h('span', { class: 'big', html: icon('print') }), 'Nothing on the list yet. Open a photo and press “Add to print list”.'));
    return;
  }
  const exportBtn = h('button', { class: 'btn primary big', html: `${icon('folder')} Copy ${plural(count, 'photo')} to a folder` });
  exportBtn.onclick = async () => {
    exportBtn.disabled = true;
    try {
      const r = await api.post('/api/print-export');
      showDialog((close) => [
        h('h2', {}, 'Done!'),
        h('p', {}, `${plural(r.copied, 'photo')} copied to:`),
        h('p', { class: 'where', style: { fontWeight: 600, wordBreak: 'break-all' } }, r.folder),
        r.failed.length ? h('p', { style: { color: 'var(--danger)' } }, `${r.failed.length} could not be copied: ${r.failed.join(', ')}`) : null,
        h('p', {}, 'The folder has been opened for you. Would you like to empty the print list now?'),
        h('div', { class: 'actions' },
          h('button', { class: 'btn', onclick: close }, 'Keep the list'),
          h('button', { class: 'btn primary', onclick: async () => { await api.post('/api/print-clear'); updatePrintBadge(); close(); render(); } }, 'Empty the list')),
      ]);
    } catch (e) {
      fail(e);
    } finally {
      exportBtn.disabled = false;
    }
  };
  const clearBtn = h('button', { class: 'btn danger', onclick: async () => { await api.post('/api/print-clear'); updatePrintBadge(); render(); } }, 'Empty the list');
  view.append(h('div', { class: 'row', style: { marginBottom: '18px' } }, exportBtn, clearBtn));
  photoGrid(view, { print: '1' }, { months: false });
};

function personCard(p) {
  return h('a', { class: 'person', href: `#/person/${p.id}?kind=${p.kind}` },
    p.cover ? h('img', { class: 'face', src: cropUrl(p.cover), alt: '' }) : h('div', { class: 'face' }),
    h('b', {}, p.name), h('span', {}, plural(p.count, 'photo')));
}
function groupCard(g, kind) {
  const m = h('div', { class: `mosaic ${g.faces.length < 4 ? 'one' : ''}` });
  for (const f of g.faces.length < 4 ? g.faces.slice(0, 1) : g.faces) m.append(h('img', { src: cropUrl(f), alt: '' }));
  return h('button', { class: 'person', onclick: () => groupDialog(g.id, kind) }, m,
    h('b', { style: { color: 'var(--accent)' } }, kind === 'pet' ? 'Name this pet' : 'Who is this?'),
    h('span', {}, plural(g.count, 'photo')));
}

async function peopleView(kind) {
  const r = await api.get(`/api/people?kind=${kind}`);
  const isPet = kind === 'pet';
  view.append(h('h1', {}, isPet ? 'Pets' : 'People'));
  if (isPet && r.pets?.length) {
    const box = h('div', { class: 'pet-kinds' });
    for (const p of r.pets) box.append(h('a', { class: 'btn', href: `#/pettype/${p.label}` }, `${p.label === 'dog' ? '🐶 All dogs' : '🐱 All cats'} (${p.n.toLocaleString()})`));
    view.append(box);
  }
  if (r.named.length) {
    const grid = h('div', { class: 'people' });
    r.named.forEach((p) => grid.append(personCard(p)));
    view.append(grid);
  }
  if (r.groups.length) {
    view.append(
      h('h2', {}, r.named.length ? (isPet ? 'More pets to name' : 'More people to name') : (isPet ? 'Give your pets names' : 'Who are these people?')),
      h('p', { class: 'sub' }, isPet
        ? 'These animals were found in your photos. Click one and type its name, then search for it by name.'
        : 'Faces that look alike have been grouped together. Click a group and type the person’s name. Then you can search for them by name.')
    );
    const grid = h('div', { class: 'people' });
    r.groups.forEach((g) => grid.append(groupCard(g, kind)));
    view.append(grid);
  }
  if (!r.named.length && !r.groups.length) {
    const st = lastStatus;
    view.append(h('div', { class: 'empty' }, h('span', { class: 'big' }, isPet ? '🐾' : '🙂'),
      st && st.analysed < st.total
        ? `Still looking through your photos for ${isPet ? 'pets' : 'faces'} (${st.analysed.toLocaleString()} of ${st.total.toLocaleString()} done). Groups will appear here as they are found.`
        : `No ${isPet ? 'pets' : 'faces'} found yet. You can also name ${isPet ? 'a pet' : 'someone'} by opening a photo.`));
  }
}
routes.people = () => peopleView('person');
routes.pets = () => peopleView('pet');
routes.pettype = async ({ arg }) => {
  view.append(h('a', { href: '#/pets', class: 'chip' }, '← Pets'), h('h1', {}, arg === 'dog' ? 'All dogs' : 'All cats'));
  photoGrid(view, { pet: arg });
};

routes.person = async ({ arg }) => {
  const id = Number(arg);
  const p = await api.get(`/api/person/${id}`);
  const isPet = p.kind === 'pet';
  const back = h('a', { href: isPet ? '#/pets' : '#/people', class: 'chip' }, isPet ? '← Pets' : '← People');
  const hero = h('div', { class: 'hero' },
    p.cover ? h('img', { class: 'face-img', src: cropUrl(p.cover), alt: '' }) : null,
    h('div', {}, h('h1', {}, p.name), h('div', { class: 'sub', style: { margin: 0 } }, plural(p.count, 'photo'))),
    h('div', { class: 'row', style: { marginLeft: 'auto' } },
      h('a', { class: 'btn', href: `#/search?q=${encodeURIComponent(p.name)}`, title: `Search for ${p.name} together with other words, e.g. “${p.name} beach”` }, h('span', { class: 'ico', html: icon('search') }), 'Search'),
      h('button', { class: 'btn', onclick: () => renameDialog(p) }, 'Change name'),
      h('button', { class: 'btn', onclick: () => fixFaces(p, area) }, 'Fix mistakes')));
  const sugg = h('div');
  const area = h('div');
  view.append(back, hero, sugg, area);
  loadSuggestions(p, sugg, () => { renderGen++; area.replaceChildren(); photoGrid(area, { person: id }); });
  photoGrid(area, { person: id });
};

// "Find more": groups that look like this person, to confirm with Yes / No.
async function loadSuggestions(p, box, refresh) {
  const list = await api.get(`/api/person/${p.id}/suggestions`);
  box.replaceChildren();
  if (!list.length) return;
  const panel = h('div', { class: 'suggest' },
    h('h2', {}, `Is this also ${p.name}?`),
    h('p', { class: 'sub', style: { margin: '0 0 6px' } }, `These look like ${p.name}. Say yes to add them, or no if it's someone else.`));
  let changed = false;
  for (const s of list.slice(0, 8)) {
    const row = h('div', { class: 'sugg' },
      h('div', { class: 'faces' }, s.faces.map((f) => h('img', { src: cropUrl(f), alt: '' }))),
      h('span', { class: 'n' }, plural(s.count, p.kind === 'pet' ? 'photo' : 'face')));
    const yes = h('button', { class: 'btn good', html: `${icon('check')} Yes` });
    const no = h('button', { class: 'btn' }, 'No');
    yes.onclick = async () => { await api.post(`/api/person/${p.id}/accept`, { group: s.group }); row.remove(); changed = true; doneCheck(); };
    no.onclick = async () => { await api.post(`/api/person/${p.id}/reject`, { group: s.group }); row.remove(); doneCheck(); };
    row.append(yes, no);
    panel.append(row);
  }
  const doneCheck = () => {
    if (!panel.querySelector('.sugg')) {
      if (changed) refresh();
      loadSuggestions(p, box, refresh); // there may be more now
    }
  };
  box.append(panel);
}

async function fixFaces(p, area) {
  renderGen++;
  const faces = await api.get(`/api/person/${p.id}/faces`);
  area.replaceChildren(
    h('h2', {}, `Is anyone here not ${p.name}?`),
    h('p', { class: 'sub' }, `Press the red ✕ on any face that isn't ${p.name}. Click a face to see its photo.`),
    h('div', { class: 'row', style: { marginBottom: '16px' } }, h('button', { class: 'btn primary', onclick: () => render() }, 'Finished'))
  );
  const grid = h('div', { class: 'facegrid' });
  const list = { items: faces.map((f) => ({ id: f.photo_id })), done: true, load() {} };
  faces.forEach((f, i) => {
    const card = h('div', { class: 'facecard' },
      h('img', { src: cropUrl(f.id), alt: '', title: 'See photo', onclick: () => openViewer(list, i) }),
      h('button', { title: `Not ${p.name}`, 'aria-label': `Not ${p.name}`, onclick: async () => { await api.post(`/api/face/${f.id}/unname`); card.remove(); } }, '✕'));
    grid.append(card);
  });
  area.append(grid);
}

routes.folders = async () => {
  const folders = await api.get('/api/folders');
  const st = await api.get('/api/status');
  view.append(h('h1', {}, 'My folders'), h('p', { class: 'sub' }, 'The app shows photos from these folders (and all folders inside them). It only ever reads your photos. It never moves, changes or deletes them.'));
  for (const f of folders) {
    view.append(h('div', { class: 'card folder' },
      h('span', { html: icon('folder') }),
      h('div', { class: 'path' }, f.path, h('small', {}, f.available ? plural(f.count, 'photo') : 'Not available right now (is a drive unplugged?)')),
      h('button', { class: 'btn small danger', onclick: async () => {
        if (!confirm(`Stop showing photos from this folder?\n\n${f.path}\n\n(The photos themselves are not touched.)`)) return;
        await api.del(`/api/folders/${f.id}`);
        render();
      } }, 'Remove')));
  }
  view.append(addFolderControls(), h('h2', {}, 'Background work'),
    h('div', { class: 'card' },
      h('p', { style: { marginTop: 0 } }, st.indexer.message || ''),
      h('p', { class: 'meta', style: { color: 'var(--muted)' } }, `${plural(st.total, 'photo')} in total · ${st.analysed.toLocaleString()} checked for people and pets`),
      st.cloud ? h('p', { class: 'meta', style: { color: 'var(--muted)' } },
        `☁ ${plural(st.cloud, 'photo')} ${st.cloud === 1 ? 'is' : 'are'} kept only in OneDrive or iCloud. They are shown using previews and are not downloaded. ` +
        (st.cloudUnchecked ? `${st.cloudUnchecked.toLocaleString()} of them haven't been checked for people yet. Each one is checked once it has been opened (downloaded).` : '')) : null,
      h('button', { class: 'btn', html: `${icon('refresh')} Look for new photos now`, onclick: async () => { await api.post('/api/rescan'); toast('Looking for new photos...'); } })));
};

function addFolderControls(big) {
  const input = h('input', { type: 'text', placeholder: 'or type a folder, e.g. D:\\Photos', 'aria-label': 'Folder path' });
  const add = async (p) => {
    try {
      await api.post('/api/folders', { path: p });
      toast('Folder added. Finding photos...');
      lastStatus = null;
      setTimeout(render, 1500);
    } catch (e) {
      fail(e);
    }
  };
  const pick = h('button', { class: `btn primary ${big ? 'big' : ''}`, html: `${icon('folder')} Choose a photo folder...` });
  pick.onclick = async () => {
    pick.disabled = true;
    toast('A folder window has opened. It may be behind this one.');
    try {
      const r = await api.post('/api/folders/pick');
      if (r.path) await add(r.path);
    } catch (e) {
      fail(e);
    } finally {
      pick.disabled = false;
    }
  };
  return h('div', { class: 'card' }, pick,
    h('form', { class: 'typed', onsubmit: (e) => { e.preventDefault(); if (input.value.trim()) add(input.value.trim()); } },
      input, h('button', { class: 'btn' }, 'Add')));
}

function renderWelcome() {
  view.append(h('div', { class: 'welcome' },
    h('div', { style: { fontSize: '64px' } }, '📷'),
    h('h1', {}, 'Welcome to Family Photos'),
    h('p', {}, 'First, show the app where your photos are kept. Your photos will not be moved or changed.'),
    addFolderControls(true)));
}

// ---------------------------------------------------------------- photo viewer
const viewerEl = $('#viewer');
let vState = null;

async function openViewer(list, index) {
  vState = { list, index, showBoxes: localGet('showBoxes', true) };
  viewerEl.hidden = false;
  await showPhoto();
}
function closeViewer() {
  viewerEl.hidden = true;
  viewerEl.replaceChildren();
  vState = null;
}
async function step(d) {
  if (!vState) return;
  const { list } = vState;
  let i = vState.index + d;
  if (i >= list.items.length && !list.done) {
    await list.load();
  }
  if (i < 0 || i >= list.items.length) return;
  vState.index = i;
  await showPhoto();
}

function localGet(k, d) {
  try {
    const v = localStorage.getItem(k);
    return v == null ? d : JSON.parse(v);
  } catch {
    return d;
  }
}
function localSet(k, v) {
  try {
    localStorage.setItem(k, JSON.stringify(v));
  } catch {}
}

async function showPhoto() {
  const { list, index } = vState;
  const id = list.items[index].id;
  const p = await api.get(`/api/photo/${id}`);
  if (!vState || list.items[vState.index].id !== id) return;
  vState.photo = p;

  // Show the small preview at once, then swap in the full photo when it arrives
  // (for OneDrive/iCloud photos that's when the download finishes).
  const where = cloudName(p.path);
  const img = h('img', { src: thumbUrl(id), alt: p.filename, class: 'preview' });
  const pill = h('div', { class: 'loading-pill', hidden: !p.cloud }, p.cloud ? `Getting this photo from ${where}…` : 'Loading…');
  const slow = setTimeout(() => (pill.hidden = false), 700);
  const full = new Image();
  full.onload = () => {
    clearTimeout(slow);
    if (vState?.photo !== p) return;
    img.src = full.src;
    img.classList.remove('preview');
    pill.remove();
    fit();
  };
  full.onerror = () => {
    clearTimeout(slow);
    pill.hidden = false;
    pill.textContent = p.cloud
      ? `Couldn't get this photo from ${where}. Is the internet connected?`
      : 'This photo could not be opened.';
  };
  full.src = `/api/photo/${id}/view`;
  const frame = h('div', { class: `frame ${vState.showBoxes ? '' : 'hide-boxes'}` }, img, pill);
  for (const f of p.faces) {
    const label = f.name || (f.kind === 'pet' ? `Name this ${f.label || 'pet'}?` : 'Who is this?');
    frame.append(h('button', {
      class: `box ${f.name ? '' : 'unknown'}`, 'data-face': f.id, title: label,
      style: { left: `${f.x * 100}%`, top: `${f.y * 100}%`, width: `${f.w * 100}%`, height: `${f.h * 100}%` },
      onclick: () => nameDialog(f),
    }, h('span', {}, label)));
  }
  const stage = h('div', { class: 'stage' },
    h('button', { class: 'close-btn', onclick: closeViewer }, '← Back'),
    frame,
    index > 0 ? h('button', { class: 'nav-btn prev', 'aria-label': 'Previous photo', onclick: () => step(-1) }, '‹') : null,
    index < list.items.length - 1 || !list.done ? h('button', { class: 'nav-btn next', 'aria-label': 'Next photo', onclick: () => step(1) }, '›') : null);

  // --- side panel
  const info = h('div', { class: 'info' });
  info.append(h('h3', {}, 'Taken'), h('div', { class: 'when' }, fmtLong(p.taken)));

  info.append(h('h3', {}, 'Who is in this photo'));
  if (!p.analysed && p.cloud) info.append(h('p', { class: 'meta' }, `This photo is kept in ${where} and hasn't been downloaded, so it hasn't been checked for people yet. Opening it downloads it, and it will then be checked.`));
  else if (!p.analysed) info.append(h('p', { class: 'meta' }, 'Not checked for people yet. This happens in the background.'));
  else if (!p.faces.length) info.append(h('p', { class: 'meta' }, 'No faces or pets were found.'));
  else {
    const who = h('div', { class: 'who' });
    for (const f of p.faces) {
      const b = h('button', { onclick: () => nameDialog(f), onmouseenter: () => frame.querySelector(`[data-face="${f.id}"]`)?.classList.add('hl'), onmouseleave: () => frame.querySelector(`[data-face="${f.id}"]`)?.classList.remove('hl') },
        h('img', { src: cropUrl(f.id), alt: '' }),
        f.name ? h('span', {}, f.name) : h('span', { class: 'unknown' }, f.kind === 'pet' ? `Name this ${f.label || 'pet'}` : 'Who is this?'));
      who.append(b);
    }
    info.append(who);
    const toggle = h('button', { class: 'btn small', style: { marginTop: '10px' } }, vState.showBoxes ? 'Hide face boxes' : 'Show face boxes');
    toggle.onclick = () => {
      vState.showBoxes = !vState.showBoxes;
      localSet('showBoxes', vState.showBoxes);
      frame.classList.toggle('hide-boxes', !vState.showBoxes);
      toggle.textContent = vState.showBoxes ? 'Hide face boxes' : 'Show face boxes';
    };
    info.append(toggle);
  }

  info.append(h('h3', {}, 'Where this photo is kept'));
  if (p.missing) info.append(h('p', { class: 'missing' }, 'This photo is no longer in its folder. It may have been moved, or its drive unplugged.'));
  info.append(h('div', { class: 'where', title: 'You can select and copy this' }, p.path));
  if (p.cloud) info.append(h('p', { class: 'meta', style: { margin: '6px 0 0' } }, `☁ Stored in ${where}. A copy is downloaded when you open, copy or print it.`));
  const reveal = h('button', { class: 'btn', html: `${icon('folder')} Show in its folder` });
  reveal.onclick = () => api.post(`/api/photo/${id}/reveal`).then(() => toast('The folder has been opened. The photo is highlighted.'), fail);
  const openBtn = h('button', { class: 'btn', html: `${icon('open')} Open in another app` });
  openBtn.onclick = () => api.post(`/api/photo/${id}/open`).catch(fail);
  info.append(reveal, openBtn);

  info.append(h('h3', {}, 'Keep'));
  const fav = h('button', { class: `btn ${p.favorite ? 'fav-on' : ''}` });
  const setFav = () => (fav.innerHTML = `${icon('heart')} ${p.favorite ? 'Favourite ✓' : 'Add to favourites'}`);
  setFav();
  fav.onclick = async () => {
    p.favorite = !p.favorite;
    await api.post(`/api/photo/${id}/favorite`, { value: p.favorite });
    list.items[index].fav = p.favorite ? 1 : 0;
    fav.classList.toggle('fav-on', p.favorite);
    setFav();
  };
  const pr = h('button', { class: `btn ${p.inPrint ? 'on' : ''}` });
  const setPr = () => (pr.innerHTML = `${icon('print')} ${p.inPrint ? 'On the print list ✓' : 'Add to print list'}`);
  setPr();
  pr.onclick = async () => {
    p.inPrint = !p.inPrint;
    const r = await api.post(`/api/print/${id}`, { value: p.inPrint });
    pr.classList.toggle('on', p.inPrint);
    setPr();
    setPrintBadge(r.count);
  };
  info.append(fav, pr);

  info.append(h('h3', {}, 'Details'),
    h('div', { class: 'meta' }, p.filename, h('br'),
      [p.w && p.h ? `${p.w} × ${p.h}` : null, p.size ? `${(p.size / 1048576).toFixed(1)} MB` : null].filter(Boolean).join(' · '),
      p.camera ? [h('br'), p.camera] : null));

  viewerEl.replaceChildren(stage, info);

  // Fit the photo to the space (the face boxes are positioned relative to it).
  const fit = () => {
    // Size by the real photo's shape (the preview is smaller but has the same shape).
    const nw = p.w || img.naturalWidth || 4;
    const nh = p.h || img.naturalHeight || 3;
    const r = Math.min((stage.clientWidth - 150) / nw, (stage.clientHeight - 40) / nh, 2);
    img.style.width = `${Math.max(50, nw * r)}px`;
    img.style.height = `${Math.max(50, nh * r)}px`;
  };
  fit();
  img.addEventListener('load', fit);
  vState.fit = fit;

  // Preload the next photo so arrows feel instant.
  const next = list.items[index + 1];
  // (Not for cloud photos: that would download a photo she hasn't asked to see.)
  if (next && !next.cloud) new Image().src = `/api/photo/${next.id}/view`;
}

addEventListener('resize', () => vState?.fit?.());
addEventListener('keydown', (e) => {
  if (!$('#modal').hidden) {
    if (e.key === 'Escape') closeModal();
    return;
  }
  if (!vState) return;
  if (e.key === 'Escape') closeViewer();
  else if (e.key === 'ArrowRight') step(1);
  else if (e.key === 'ArrowLeft') step(-1);
});

// ---------------------------------------------------------------- dialogs
let closeModal = () => {};
function showDialog(build) {
  const m = $('#modal');
  const close = () => {
    m.hidden = true;
    m.replaceChildren();
  };
  closeModal = close;
  const dlg = h('div', { class: 'dialog', role: 'dialog', 'aria-modal': 'true' }, build(close));
  m.replaceChildren(dlg);
  m.hidden = false;
  m.onclick = (e) => e.target === m && close();
  dlg.querySelector('input')?.focus();
  return close;
}

/** Name input with clickable existing names underneath. */
async function nameInput(kind, initial, onSubmit) {
  const names = await api.get(`/api/names?kind=${kind}`);
  const input = h('input', { type: 'text', placeholder: kind === 'pet' ? 'Pet’s name' : 'Their name', value: initial || '', autocomplete: 'off' });
  const list = h('div', { class: 'namelist' });
  const fill = () => {
    const q = input.value.trim().toLowerCase();
    list.replaceChildren(...names.filter((n) => !q || n.name.toLowerCase().includes(q)).slice(0, 10)
      .map((n) => h('button', { type: 'button', class: 'chip', onclick: () => onSubmit(n.name) }, n.name)));
  };
  input.addEventListener('input', fill);
  input.addEventListener('keydown', (e) => e.key === 'Enter' && input.value.trim() && onSubmit(input.value.trim()));
  fill();
  return { input, list };
}

async function nameDialog(face) {
  const kind = face.kind === 'pet' ? 'pet' : 'person';
  const save = async (name) => {
    try {
      const r = await api.post(`/api/face/${face.id}/name`, { name });
      close();
      refreshViewer();
      toast(`Saved: ${r.person.name}`, { label: `Find more of ${r.person.name}`, run: () => { closeViewer(); go(`#/person/${r.person.id}?kind=${kind}`); } });
    } catch (e) {
      fail(e);
    }
  };
  const { input, list } = await nameInput(kind, '', save);
  const close = showDialog((close) => [
    h('div', { style: { textAlign: 'center' } }, h('img', { class: 'face-img', src: cropUrl(face.id), alt: '' })),
    h('h2', { style: { textAlign: 'center' } }, face.name ? `This is ${face.name}` : kind === 'pet' ? 'What is this pet called?' : 'Who is this?'),
    face.name ? h('p', { class: 'sub', style: { textAlign: 'center' } }, 'If that’s wrong, type the right name below.') : null,
    input, list,
    h('div', { class: 'actions' },
      face.name ? h('button', { class: 'btn', onclick: async () => { await api.post(`/api/face/${face.id}/unname`); close(); refreshViewer(); toast(`Removed. That isn't ${face.name}.`); } }, `Not ${face.name}`) : null,
      h('button', { class: 'btn', onclick: close }, 'Cancel'),
      h('button', { class: 'btn primary', onclick: () => input.value.trim() && save(input.value.trim()) }, 'Save')),
    h('button', { class: 'link', onclick: async () => { await api.post(`/api/face/${face.id}/delete`); close(); refreshViewer(); } },
      kind === 'pet' ? 'This isn’t an animal' : 'This isn’t a face'),
  ]);
}

async function groupDialog(groupId, kind) {
  const g = await api.get(`/api/group/${groupId}`);
  const save = async (name) => {
    try {
      const r = await api.post(`/api/group/${groupId}/name`, { name });
      close();
      toast(`Saved: ${r.person.name}`, { label: 'See photos', run: () => go(`#/person/${r.person.id}?kind=${kind}`) });
      render();
    } catch (e) {
      fail(e);
    }
  };
  const { input, list } = await nameInput(kind, '', save);
  const plist = { items: g.faces.map((f) => ({ id: f.photo_id })), done: true, load() {} };
  const close = showDialog((close) => [
    h('h2', {}, kind === 'pet' ? 'What is this pet called?' : 'Who is this?'),
    h('div', { class: 'faces-row' }, g.faces.slice(0, 18).map((f, i) => h('img', { src: cropUrl(f.id), alt: '', title: 'See photo', style: { cursor: 'pointer' }, onclick: () => { close(); openViewer(plist, i); } }))),
    h('p', { class: 'sub' }, `${plural(g.faces.length, 'photo')}. If one or two are someone else, you can fix that afterwards.`),
    input, list,
    h('div', { class: 'actions' },
      h('button', { class: 'btn', onclick: close }, 'Cancel'),
      h('button', { class: 'btn primary', onclick: () => input.value.trim() && save(input.value.trim()) }, 'Save')),
    h('button', { class: 'link', onclick: async () => { await api.post(`/api/group/${groupId}/ignore`); close(); render(); } },
      kind === 'pet' ? 'Not our pet: hide this group' : 'Don’t know them: hide this group'),
  ]);
}

function renameDialog(p) {
  const input = h('input', { type: 'text', value: p.name });
  const save = async () => {
    try {
      const r = await api.post(`/api/person/${p.id}/rename`, { name: input.value });
      close();
      if (r.merged) toast(`Joined together with the existing ${r.person.name}`);
      go(`#/person/${r.person.id}?kind=${p.kind}`);
    } catch (e) {
      fail(e);
    }
  };
  input.addEventListener('keydown', (e) => e.key === 'Enter' && save());
  const close = showDialog((close) => [
    h('h2', {}, 'Change name'),
    h('p', { class: 'sub' }, 'If you type a name that already exists, the two will be joined together.'),
    input,
    h('div', { class: 'actions' },
      h('button', { class: 'btn danger', onclick: async () => {
        if (!confirm(`Remove the name “${p.name}” from all photos? (The photos are not deleted.)`)) return;
        await api.del(`/api/person/${p.id}`);
        close();
        go(p.kind === 'pet' ? '#/pets' : '#/people');
      } }, 'Remove this name'),
      h('button', { class: 'btn', onclick: close }, 'Cancel'),
      h('button', { class: 'btn primary', onclick: save }, 'Save')),
  ]);
}

function refreshViewer() {
  if (vState) showPhoto();
}

// ---------------------------------------------------------------- search box
$('#searchForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const q = $('#searchInput').value.trim();
  $('#searchInput').blur();
  go(q ? `#/search?q=${encodeURIComponent(q)}` : '#/photos');
});
$('#searchInput').addEventListener('input', () => ($('#searchClear').hidden = !$('#searchInput').value));
$('#searchClear').addEventListener('click', () => {
  $('#searchInput').value = '';
  $('#searchClear').hidden = true;
  if (parseHash().name === 'search') go('#/photos');
  $('#searchInput').focus();
});

// ---------------------------------------------------------------- status & badge
function setPrintBadge(n) {
  const b = $('#printBadge');
  b.hidden = !n;
  b.textContent = n;
}
async function updatePrintBadge() {
  try {
    setPrintBadge((await api.get('/api/print')).count);
  } catch {}
}

async function pollStatus() {
  try {
    const st = await api.get('/api/status');
    const prev = lastStatus;
    lastStatus = st;
    const s = st.indexer || {};
    $('#statusText').textContent = s.phase === 'idle' ? `✓ ${plural(st.total, 'photo')}, all up to date` : s.message || '';
    const showBar = ['ai', 'thumbnails', 'downloading'].includes(s.phase) && s.total > 0;
    $('#statusBar').hidden = !showBar;
    if (showBar) $('#statusBar i').style.width = `${Math.round((100 * s.done) / s.total)}%`;
    // First photos just arrived: show them.
    const r = parseHash();
    if (prev && !vState && $('#modal').hidden && r.name === 'photos' && prev.total === 0 && st.total > 0) render();
  } catch {
    $('#statusText').textContent = 'The app has stopped. Please open it again from the desktop icon.';
  }
  setTimeout(pollStatus, 3000);
}

pollStatus();
updatePrintBadge();
render();
