// Asuntovahti UI. Loads the daily crawl (data/listings.json), filters it in the
// browser by the user's criteria and keeps criteria + saved/rejected listings in
// localStorage. "Kopioi linkki" packs that state into the URL for another device.

const STORAGE_KEY = 'asuntovahti:v1';
const NEW_WINDOW_MS = 36 * 60 * 60 * 1000; // first seen within the latest daily crawl
const PAGE = 60;
const SAVE_ANIMATION_MS = 1000;

const DEFAULT_CRITERIA = {
  zips: ['00120'],
  priceMin: null, priceMax: null,
  sqmMin: null, sqmMax: null,
  sizeMin: 60, sizeMax: null,
  yearMin: null, yearMax: 1919,
  rooms: [], lots: [], types: [],
};
const EMPTY_CRITERIA = { ...DEFAULT_CRITERIA, zips: [], sizeMin: null, yearMax: null };

const BUILDING_TYPES = { 1: 'Kerrostalo', 2: 'Rivitalo', 4: 'Omakotitalo', 64: 'Paritalo' };
const LOT_TYPES = { 1: 'Oma tontti', 2: 'Vuokratontti', 3: 'Valinnainen vuokratontti' };
const NUMBER_FIELDS = ['priceMin', 'priceMax', 'sqmMin', 'sqmMax', 'sizeMin', 'sizeMax', 'yearMin', 'yearMax'];

const $ = (sel) => document.querySelector(sel);
const euro = new Intl.NumberFormat('fi-FI', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 });
const num = new Intl.NumberFormat('fi-FI', { maximumFractionDigits: 1 });
const dateFmt = new Intl.DateTimeFormat('fi-FI', { day: 'numeric', month: 'numeric', year: 'numeric' });
const dateTimeFmt = new Intl.DateTimeFormat('fi-FI', { day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit' });

let listings = [];
let byId = new Map();
let crawledAt = 0;
let tab = 'matches';
let shown = PAGE;
let state = loadState();

function loadState() {
  let stored = {};
  try {
    stored = JSON.parse(localStorage.getItem(STORAGE_KEY)) ?? {};
  } catch { /* corrupt or unavailable storage: start fresh */ }
  return {
    criteria: { ...DEFAULT_CRITERIA, ...stored.criteria },
    saved: stored.saved ?? {},       // id -> listing snapshot, so saved ones survive delisting
    rejected: stored.rejected ?? [], // ids
    sort: stored.sort ?? 'newest',
  };
}

function persist() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch { /* private mode etc. */ }
}

// ---- Sharing state through the URL -----------------------------------------

function importFromHash() {
  const m = location.hash.match(/^#tila=(.+)$/);
  if (!m) return;
  try {
    const shared = JSON.parse(atob(m[1].replace(/-/g, '+').replace(/_/g, '/')));
    state.criteria = { ...DEFAULT_CRITERIA, ...shared.c };
    state.rejected = [...new Set([...state.rejected, ...(shared.r ?? [])])];
    for (const id of shared.s ?? []) state.saved[id] ??= byId.get(id) ?? { id };
    persist();
  } catch {
    toast('Linkin tilaa ei voitu lukea');
  }
  history.replaceState(null, '', location.pathname + location.search);
}

async function copyShareLink() {
  const payload = { c: state.criteria, s: Object.keys(state.saved).map(Number), r: state.rejected };
  const encoded = btoa(JSON.stringify(payload)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const url = `${location.origin}${location.pathname}#tila=${encoded}`;
  try {
    await navigator.clipboard.writeText(url);
    toast('Linkki kopioitu – avaa se toisella laitteella');
  } catch {
    prompt('Kopioi linkki:', url);
  }
}

// ---- Filtering ---------------------------------------------------------------

const between = (value, min, max) =>
  (min == null || (value != null && value >= min)) && (max == null || (value != null && value <= max));

function matches(l, c) {
  if (c.zips.length && !c.zips.includes(l.zip)) return false;
  if (!between(l.price, c.priceMin, c.priceMax)) return false;
  if (!between(sqm(l), c.sqmMin, c.sqmMax)) return false;
  if (!between(l.size, c.sizeMin, c.sizeMax)) return false;
  if (!between(l.year, c.yearMin, c.yearMax)) return false;
  if (c.rooms.length && !c.rooms.includes(Math.min(l.rooms ?? 0, 5))) return false;
  if (c.lots.length && !c.lots.includes(l.lot ?? 0)) return false;
  if (c.types.length && !c.types.includes(l.type in BUILDING_TYPES ? l.type : 0)) return false;
  return true;
}

const isNew = (l) => crawledAt - Date.parse(l.firstSeen) < NEW_WINDOW_MS;
const sqm = (l) => (l.price && l.size ? l.price / l.size : null);
const nullsLast = (f, dir = 1) => (a, b) => {
  const x = f(a), y = f(b);
  if (x == null || y == null) return (x == null) - (y == null);
  return (x - y) * dir;
};
const SORTS = {
  newest: (a, b) => Date.parse(b.firstSeen) - Date.parse(a.firstSeen) || Date.parse(b.published) - Date.parse(a.published),
  priceAsc: nullsLast((l) => l.price),
  priceDesc: nullsLast((l) => l.price, -1),
  sqmAsc: nullsLast(sqm),
  sizeDesc: nullsLast((l) => l.size, -1),
};

function currentMatches() {
  const rejected = new Set(state.rejected);
  return listings.filter((l) => !rejected.has(l.id) && !(l.id in state.saved) && matches(l, state.criteria));
}

// ---- Rendering ---------------------------------------------------------------

const urlOf = (l) => `https://asunnot.oikotie.fi/myytavat-asunnot/kohde/${l.id}`;
const imgOf = (l) => (l.img.startsWith('http') ? l.img : 'https://cdn.asunnot.oikotie.fi/' + l.img);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

function cardHtml(l, { saved }) {
  const gone = saved && !byId.has(l.id);
  const fresh = !saved && isNew(l);
  const perSqm = sqm(l);
  const floor = l.floor ? `${l.floor}${l.floors ? '/' + l.floors : ''}. krs` : '';
  const facts = [
    l.size && `${num.format(l.size)} m²`,
    l.rooms && `${l.rooms} h`,
    l.year && `rv. ${l.year}`,
    floor,
  ].filter(Boolean);
  const tags = [BUILDING_TYPES[l.type], LOT_TYPES[l.lot], l.newDev && 'Uudiskohde'].filter(Boolean);
  const badges = [
    fresh && '<span class="badge new">UUSI</span>',
    gone && '<span class="badge">Poistunut myynnistä</span>',
  ].filter(Boolean).join('');

  return `
    <article class="card${fresh ? ' is-new' : ''}" data-id="${l.id}">
      <a class="photo" href="${urlOf(l)}" target="_blank" rel="noopener">
        ${l.img ? `<img src="${esc(imgOf(l))}" alt="" loading="lazy">` : ''}
        <div class="badges">${badges}</div>
      </a>
      <div class="body">
        <div class="price">${l.price ? euro.format(l.price) : 'Hinta ei tiedossa'}${perSqm ? `<small>${euro.format(perSqm)}/m²</small>` : ''}</div>
        <div class="address"><a href="${urlOf(l)}" target="_blank" rel="noopener">${esc(l.address || 'Osoite ei tiedossa')}</a></div>
        <div class="muted">${esc([l.zip, l.district, l.city].filter(Boolean).join(' · '))}</div>
        <div class="facts">${facts.map((f) => `<span>${esc(f)}</span>`).join('')}</div>
        ${l.layout ? `<div class="layout-text">${esc(l.layout)}</div>` : ''}
        <div class="tags">${tags.map((t) => `<span class="tag">${esc(t)}</span>`).join('')}${l.published ? `<span class="tag">Julkaistu ${dateFmt.format(new Date(l.published))}</span>` : ''}</div>
      </div>
      <div class="actions">
        ${saved
          ? '<button class="reject" data-action="unsave">Poista tallennetuista</button>'
          : '<button class="reject" data-action="reject">✕ Hylkää</button><button class="save" data-action="save"><span class="heart">♥</span> <span class="label">Tallenna</span></button>'}
      </div>
    </article>`;
}

function emptyHtml(title, text) {
  return `<div class="empty"><strong>${title}</strong>${text}</div>`;
}

function render() {
  const all = currentMatches();
  const newCount = all.filter(isNew).length;
  const savedList = Object.values(state.saved).map((s) => byId.get(s.id) ?? s);

  $('#count-matches').textContent = all.length;
  $('#count-saved').textContent = savedList.length;
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === tab));
  $('#only-new-label').hidden = $('.sort').hidden = tab !== 'matches';

  let items, html;
  if (tab === 'saved') {
    items = savedList;
    $('#summary').textContent = items.length ? `${items.length} tallennettua kohdetta` : '';
    html = items.length
      ? items.map((l) => cardHtml(l, { saved: true })).join('')
      : emptyHtml('Ei tallennettuja kohteita', 'Paina ♥ Tallenna kohteessa, josta haluat pitää kiinni.');
  } else {
    items = ($('#only-new').checked ? all.filter(isNew) : all).sort(SORTS[state.sort]);
    $('#summary').textContent = `${all.length} sopivaa kohdetta, joista ${newCount} uutta`;
    html = items.length
      ? items.slice(0, shown).map((l) => cardHtml(l, { saved: false })).join('')
      : emptyHtml('Ei sopivia kohteita', 'Kokeile väljentää hakuehtoja – uudet kohteet haetaan kerran päivässä.');
  }
  $('#list').innerHTML = html;
  $('#more').hidden = tab !== 'matches' || items.length <= shown;

  const n = state.rejected.length;
  $('#rejected-info').innerHTML = n ? `${n} hylättyä kohdetta piilotettu · <button id="restore">palauta kaikki</button>` : '';
}

function renderCriteria() {
  const c = state.criteria;
  for (const field of NUMBER_FIELDS) $(`[name=${field}]`).value = c[field] ?? '';
  document.querySelectorAll('.toggles').forEach((group) => {
    group.querySelectorAll('button').forEach((b) => b.classList.toggle('on', c[group.dataset.field].includes(Number(b.dataset.value))));
  });
  $('#zip-chips').innerHTML = c.zips
    .map((z) => `<span class="chip">${esc(z)}<button type="button" data-zip="${esc(z)}" aria-label="Poista ${esc(z)}">×</button></span>`)
    .join('');
  $('#sort').value = state.sort;
}

function celebrate(card, button) {
  card.classList.add('saving');
  button.classList.add('saving');
  button.querySelector('.label').textContent = 'Tallennettu!';
  for (let i = 0; i < 9; i++) {
    const heart = document.createElement('span');
    heart.className = 'burst';
    heart.textContent = '♥';
    heart.style.setProperty('--dx', `${Math.round((Math.random() - 0.5) * 220)}px`);
    heart.style.setProperty('--dy', `${-60 - Math.round(Math.random() * 110)}px`);
    heart.style.setProperty('--rot', `${Math.round((Math.random() - 0.5) * 80)}deg`);
    heart.style.setProperty('--size', `${14 + Math.round(Math.random() * 14)}px`);
    heart.style.setProperty('--delay', `${Math.round(Math.random() * 180)}ms`);
    button.append(heart);
  }
}

let toastTimer;
function toast(message, undo) {
  const el = $('#toast');
  el.innerHTML = `<span>${esc(message)}</span>${undo ? '<button>Kumoa</button>' : ''}`;
  if (undo) el.querySelector('button').onclick = () => { undo(); el.hidden = true; };
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 5000);
}

function update() {
  persist();
  render();
}

// ---- Events ------------------------------------------------------------------

function criteriaChanged() {
  shown = PAGE;
  renderCriteria();
  update();
}

function addZip(raw) {
  const zip = raw.trim();
  const hint = $('#zip-hint');
  if (!/^\d{5}$/.test(zip)) {
    hint.textContent = 'Postinumerossa on viisi numeroa';
    return;
  }
  hint.textContent = listings.some((l) => l.zip === zip)
    ? 'Tyhjä = koko pääkaupunkiseutu'
    : `Postinumerolla ${zip} ei ole kohteita (haku kattaa pääkaupunkiseudun)`;
  if (!state.criteria.zips.includes(zip)) state.criteria.zips.push(zip);
  $('#zip-input').value = '';
  criteriaChanged();
}

function bindEvents() {
  document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => {
    tab = t.dataset.tab;
    render();
  }));

  let debounce;
  $('#criteria').addEventListener('input', (e) => {
    if (!NUMBER_FIELDS.includes(e.target.name)) return;
    state.criteria[e.target.name] = e.target.value === '' ? null : Number(e.target.value);
    clearTimeout(debounce);
    debounce = setTimeout(() => { shown = PAGE; update(); }, 250);
  });
  $('#criteria').addEventListener('submit', (e) => e.preventDefault());

  document.querySelectorAll('.toggles').forEach((group) => group.addEventListener('click', (e) => {
    const button = e.target.closest('button');
    if (!button) return;
    const value = Number(button.dataset.value);
    const selected = state.criteria[group.dataset.field];
    state.criteria[group.dataset.field] = selected.includes(value) ? selected.filter((v) => v !== value) : [...selected, value];
    criteriaChanged();
  }));

  $('#zip-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ',' || e.key === ' ') {
      e.preventDefault();
      addZip(e.target.value);
    }
  });
  $('#zip-input').addEventListener('change', (e) => e.target.value && addZip(e.target.value));
  $('#zip-chips').addEventListener('click', (e) => {
    const zip = e.target.dataset.zip;
    if (!zip) return;
    state.criteria.zips = state.criteria.zips.filter((z) => z !== zip);
    criteriaChanged();
  });

  $('#reset').addEventListener('click', () => {
    state.criteria = structuredClone(EMPTY_CRITERIA);
    criteriaChanged();
  });
  $('#sort').addEventListener('change', (e) => { state.sort = e.target.value; update(); });
  $('#only-new').addEventListener('change', render);
  $('#more').addEventListener('click', () => { shown += PAGE; render(); });
  $('#share').addEventListener('click', copyShareLink);

  $('#list').addEventListener('click', (e) => {
    const button = e.target.closest('[data-action]');
    if (!button) return;
    const action = button.dataset.action;
    const card = button.closest('.card');
    if (card.classList.contains('saving')) return;
    const id = Number(card.dataset.id);
    if (action === 'save') {
      // Let the celebration play for a second before the card leaves the list.
      celebrate(card, button);
      setTimeout(() => {
        state.saved[id] = byId.get(id);
        toast('Tallennettu', () => { delete state.saved[id]; update(); });
        update();
      }, SAVE_ANIMATION_MS);
      return;
    } else if (action === 'reject') {
      state.rejected.push(id);
      toast('Hylätty – ei näytetä enää', () => { state.rejected = state.rejected.filter((r) => r !== id); update(); });
    } else if (action === 'unsave') {
      const snapshot = state.saved[id];
      delete state.saved[id];
      toast('Poistettu tallennetuista', () => { state.saved[id] = snapshot; update(); });
    }
    update();
  });

  $('#rejected-info').addEventListener('click', (e) => {
    if (e.target.id !== 'restore') return;
    const previous = state.rejected;
    state.rejected = [];
    toast('Hylätyt palautettu', () => { state.rejected = previous; update(); });
    update();
  });
}

// ---- Start -------------------------------------------------------------------

async function start() {
  // On phones the criteria panel would fill the first screen, so start it collapsed.
  if (matchMedia('(max-width: 860px)').matches) $('#filters-details').open = false;
  bindEvents();
  renderCriteria();
  try {
    const data = await (await fetch('data/listings.json', { cache: 'no-cache' })).json();
    listings = data.listings;
    byId = new Map(listings.map((l) => [l.id, l]));
    crawledAt = Date.parse(data.crawledAt);
    $('#crawl-info').textContent = `${listings.length.toLocaleString('fi-FI')} myytävää asuntoa Oikotieltä · päivitetty ${dateTimeFmt.format(crawledAt)}`;
    $('#zip-list').innerHTML = [...new Set(listings.map((l) => l.zip))].sort().map((z) => `<option value="${z}">`).join('');
    // Refresh snapshots of saved listings that are still on the market.
    for (const id of Object.keys(state.saved)) if (byId.has(Number(id))) state.saved[id] = byId.get(Number(id));
  } catch (err) {
    console.error(err);
    $('#crawl-info').textContent = 'Kohteiden lataus epäonnistui';
  }
  importFromHash();
  renderCriteria();
  update();
}

start();
