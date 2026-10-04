// Crawls for-sale listings from Oikotie for the configured cities and writes
// data/listings.json. Run daily by GitHub Actions (.github/workflows/crawl.yml).
//
// Oikotie has no official public API; this uses the same JSON endpoint as their
// own search page. Search cards do not include the postal code or the lot
// ownership type, so we query once per postal code and once per lot type and
// tag each listing with the query it came back from.
import { readFile, writeFile, mkdir } from 'node:fs/promises';

const BASE = 'https://asunnot.oikotie.fi';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const DATA_DIR = new URL('../data/', import.meta.url);
const CDN = 'https://cdn.asunnot.oikotie.fi/';
const PAGE_SIZE = 1000;
const DELAY_MS = 150;

// Postal code ranges to crawl, and the Oikotie location ids of the cities they belong to.
const ZIP_RANGES = [[100, 990], [1200, 1770], [2100, 2980]];
const CITIES = { Helsinki: 64, Espoo: 39, Vantaa: 65, Kauniainen: 130 };
const LOT_TYPES = [1, 2, 3]; // 1 = oma, 2 = vuokra, 3 = valinnainen vuokratontti

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let headers;

async function refreshTokens() {
  const html = await (await fetch(`${BASE}/myytavat-asunnot`, { headers: { 'User-Agent': UA } })).text();
  const meta = (name) => {
    const m = html.match(new RegExp(`<meta name="${name}" content="([^"]*)"`));
    if (!m) throw new Error(`Token "${name}" not found on Oikotie search page`);
    return m[1];
  };
  headers = { 'User-Agent': UA, 'OTA-token': meta('api-token'), 'OTA-loaded': meta('loaded'), 'OTA-cuid': meta('cuid') };
}

async function api(path, attempt = 1) {
  await sleep(DELAY_MS);
  const res = await fetch(BASE + path, { headers, signal: AbortSignal.timeout(120_000) });
  if (res.ok) return res.json();
  if (attempt >= 3) throw new Error(`${res.status} from ${path}`);
  await sleep(2000 * attempt);
  await refreshTokens();
  return api(path, attempt + 1);
}

async function readJson(name) {
  try {
    return JSON.parse(await readFile(new URL(name, DATA_DIR), 'utf8'));
  } catch {
    return null;
  }
}

// Postal code -> Oikotie location id. Looked up once and cached in the repo.
async function loadPostcodes() {
  const cached = await readJson('postcodes.json');
  if (cached) return cached;
  const postcodes = [];
  for (const [from, to] of ZIP_RANGES) {
    for (let n = from; n <= to; n += 10) {
      const zip = String(n).padStart(5, '0');
      const hits = await api(`/api/3.0/location?query=${zip}`);
      const hit = hits.find((h) => h.card.cardType === 5 && h.card.name === zip);
      if (hit && hit.parent?.name in CITIES) postcodes.push({ zip, id: hit.card.cardId, city: hit.parent.name });
    }
  }
  await writeFile(new URL('postcodes.json', DATA_DIR), JSON.stringify(postcodes, null, 1) + '\n');
  return postcodes;
}

async function fetchCards(location, extra = '') {
  const loc = encodeURIComponent(JSON.stringify([location]));
  const cards = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const page = await api(`/api/cards?cardType=100&limit=${PAGE_SIZE}&offset=${offset}&sortBy=published_sort_desc&locations=${loc}${extra}`);
    cards.push(...page.cards);
    if (page.cards.length < PAGE_SIZE || cards.length >= page.found) return cards;
  }
}

const firstNumber = (text) => {
  const m = String(text ?? '').replace(/\s/g, '').match(/\d+(?:[.,]\d+)?/);
  return m ? Number(m[0].replace(',', '.')) : null;
};

function toListing(card, { zip, city }, lot, firstSeen) {
  const b = card.buildingData ?? {};
  // Stored without the CDN host to keep the data file small; the UI adds it back.
  const img = (card.images?.feedx2 ?? card.images?.wide)?.replace(CDN, '') ?? null;
  return {
    id: card.id,
    address: b.address ?? '',
    district: b.district ?? '',
    city,
    zip,
    price: firstNumber(card.price),
    size: card.size ?? card.sizeMin ?? null,
    rooms: card.rooms ?? null,
    layout: card.roomConfiguration ?? '',
    year: b.year ?? null,
    type: b.buildingType ?? null,
    floor: b.floor ?? null,
    floors: b.floorCount ?? null,
    lot: lot ?? null,
    newDev: card.newDevelopment || undefined,
    img,
    published: card.published,
    firstSeen,
  };
}

async function main() {
  await mkdir(DATA_DIR, { recursive: true });
  await refreshTokens();

  const previous = await readJson('listings.json');
  const seenBefore = new Map((previous?.listings ?? []).map((l) => [l.id, l.firstSeen]));
  const now = new Date().toISOString();

  const postcodes = await loadPostcodes();
  console.log(`Crawling ${postcodes.length} postal codes`);

  const lotById = new Map();
  for (const [city, id] of Object.entries(CITIES)) {
    for (const lot of LOT_TYPES) {
      const cards = await fetchCards([id, 6, city], `&lotOwnershipType%5B%5D=${lot}`);
      for (const card of cards) lotById.set(card.id, lot);
      console.log(`${city}, lot type ${lot}: ${cards.length}`);
    }
  }

  const listings = new Map();
  for (const postcode of postcodes) {
    const { zip, id } = postcode;
    const cards = await fetchCards([id, 5, zip]);
    console.log(`${zip}: ${cards.length}`);
    for (const card of cards) {
      // On the very first crawl nothing is "new to us", so fall back to the publish date.
      const firstSeen = seenBefore.get(card.id) ?? (previous ? now : card.published);
      listings.set(card.id, toListing(card, postcode, lotById.get(card.id), firstSeen));
    }
  }

  if (previous && listings.size < previous.listings.length * 0.5) {
    throw new Error(`Only ${listings.size} listings found (previously ${previous.listings.length}); refusing to overwrite`);
  }

  // One listing per line, sorted by id, so daily git diffs stay small.
  const sorted = [...listings.values()].sort((a, b) => a.id - b.id);
  const added = previous ? sorted.filter((l) => !seenBefore.has(l.id)).length : 0;
  const body = sorted.map((l) => JSON.stringify(l)).join(',\n');
  await writeFile(
    new URL('listings.json', DATA_DIR),
    `{"crawledAt":${JSON.stringify(now)},"count":${sorted.length},"listings":[\n${body}\n]}\n`,
  );
  console.log(`Wrote ${sorted.length} listings (${added} new since last crawl)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
