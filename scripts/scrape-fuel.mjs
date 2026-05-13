// Scrapes regulated petroleum derivative prices from the Slovenian energy portal
// and writes them to data/fuel-prices.json.
// Run via GitHub Actions weekly (see .github/workflows/scrape-fuel.yml).

import { writeFile } from 'node:fs/promises';

const SOURCE_URL = 'https://www.energetika-portal.si/podrocja/energetika/cene-naftnih-derivatov/regulirane-cene-naftnih-derivatov/';

const res = await fetch(SOURCE_URL, {
  headers: { 'User-Agent': 'Mozilla/5.0 (fuel-price-scraper; +https://github.com/simonm200012/revenue-expenses-dashboard)' }
});
if (!res.ok) {
  console.error('Fetch failed:', res.status, res.statusText);
  process.exit(1);
}
const html = await res.text();

// Find the first <table>...</table>
const tableMatch = html.match(/<table[^>]*>([\s\S]*?)<\/table>/);
if (!tableMatch) { console.error('No table found on page.'); process.exit(1); }
const table = tableMatch[0];

const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/g;
const cellRe = /<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/g;

const prices = [];
let rowMatch;
while ((rowMatch = rowRe.exec(table)) !== null) {
  const rowHtml = rowMatch[1];
  const cells = [];
  let cm;
  cellRe.lastIndex = 0;
  while ((cm = cellRe.exec(rowHtml)) !== null) {
    cells.push(cm[1].replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim());
  }
  if (cells.length !== 4) continue;
  const dm = cells[0].match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
  if (!dm) continue;
  const [, d, mo, y] = dm;
  const iso = `${y}-${mo}-${d}`;
  const num = s => {
    const n = parseFloat(s.replace(',', '.').trim());
    return Number.isFinite(n) ? n : null;
  };
  const nmb95 = num(cells[1]);
  const diesel = num(cells[2]);
  const elko = num(cells[3]);
  if (nmb95 === null) continue;
  prices.push({ date: iso, nmb95, diesel, elko });
}

if (prices.length === 0) {
  console.error('Parsed 0 price rows. Page structure may have changed.');
  process.exit(1);
}

prices.sort((a, b) => b.date.localeCompare(a.date));

const out = {
  source: SOURCE_URL,
  updated: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
  currency: 'EUR',
  unit: 'per liter',
  fuels: [
    { key: 'nmb95', label: 'Petrol NMB-95' },
    { key: 'diesel', label: 'Diesel' },
    { key: 'elko', label: 'Heating oil (ELKO)' }
  ],
  prices
};

await writeFile(
  new URL('../data/fuel-prices.json', import.meta.url),
  JSON.stringify(out, null, 2) + '\n'
);
console.log(`Wrote ${prices.length} price records. Latest: ${prices[0].date} \u2014 NMB95=${prices[0].nmb95}, Diesel=${prices[0].diesel}, ELKO=${prices[0].elko}`);
