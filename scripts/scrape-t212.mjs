// Fetches the Trading 212 portfolio + cash balance and writes them to
// data/t212-portfolio.json. Runs from .github/workflows/scrape-t212.yml.
//
// Required env: T212_API_KEY (stored as a GitHub Actions secret).
// T212 uses the API key directly as the Authorization header value (no "Bearer ").

import { writeFile, mkdir } from 'node:fs/promises';

// Trim whitespace — GitHub secrets sometimes pick up a trailing newline on paste.
const API_KEY = (process.env.T212_API_KEY || '').trim();
if (!API_KEY) {
  console.error('Missing T212_API_KEY env variable.');
  process.exit(1);
}
// Print a sanitized key fingerprint so you can verify the secret matches what you generated.
const keyHint = API_KEY.length >= 12
  ? `${API_KEY.slice(0,4)}...${API_KEY.slice(-4)} (length ${API_KEY.length})`
  : `(${API_KEY.length} chars)`;
console.log('Using API key:', keyHint);

const ENV = (process.env.T212_ENV || 'live').toLowerCase();
const BASE = ENV === 'demo'
  ? 'https://demo.trading212.com'
  : 'https://live.trading212.com';
console.log('Environment:', ENV, BASE);

const HEADERS = { Authorization: API_KEY, Accept: 'application/json' };

async function t212(path) {
  const res = await fetch(BASE + path, { headers: HEADERS });
  if (!res.ok) {
    const body = await res.text();
    const errMsg = `${path} -> HTTP ${res.status}: ${body.slice(0, 300)}`;
    if (res.status === 401) {
      throw new Error(errMsg + '\n  \u2192 Possible causes: API key has whitespace, key was generated for Demo (set T212_ENV=demo), or required scopes missing.');
    }
    if (res.status === 403) {
      throw new Error(errMsg + '\n  \u2192 The API key works but lacks the required scope. Regenerate it with portfolio:read + account:read enabled.');
    }
    if (res.status === 429) {
      throw new Error(errMsg + '\n  \u2192 Rate limited. Most endpoints are 1 req / 30s.');
    }
    throw new Error(errMsg);
  }
  return res.json();
}

// T212 rate limit: most endpoints are 1 request / 30s. Space the calls
// (the timer is per-endpoint, but be polite anyway).
async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Fetch in series with small gaps. account/info is optional.
let cash = null, portfolio = [], info = null;
try {
  cash = await t212('/api/v0/equity/account/cash');
} catch (e) {
  console.error('cash error:', e.message);
}
await sleep(1500);
try {
  portfolio = await t212('/api/v0/equity/portfolio');
} catch (e) {
  console.error('portfolio error:', e.message);
  if (!cash) process.exit(1);
}
await sleep(1500);
try {
  info = await t212('/api/v0/equity/account/info');
} catch (e) {
  // Non-fatal — not every API key has account:read scope
  console.warn('account/info skipped:', e.message);
}

// Normalize positions
const positions = (Array.isArray(portfolio) ? portfolio : []).map(p => {
  const qty = parseFloat(p.quantity) || 0;
  const avg = parseFloat(p.averagePrice) || 0;
  const cur = parseFloat(p.currentPrice) || 0;
  const marketValue = qty * cur;
  const costBasis = qty * avg;
  // T212 returns ppl (profit/loss) in the account currency
  const ppl = (p.ppl !== undefined && p.ppl !== null) ? parseFloat(p.ppl) : (marketValue - costBasis);
  return {
    ticker: p.ticker || '',
    quantity: qty,
    averagePrice: avg,
    currentPrice: cur,
    marketValue: Math.round(marketValue * 100) / 100,
    costBasis: Math.round(costBasis * 100) / 100,
    unrealizedPL: Math.round(ppl * 100) / 100,
    unrealizedPLPct: costBasis > 0 ? Math.round((ppl / costBasis) * 10000) / 100 : 0,
    fxPpl: parseFloat(p.fxPpl) || 0,
    initialFillDate: p.initialFillDate || '',
    pieQuantity: parseFloat(p.pieQuantity) || 0,
    frontend: p.frontend || ''
  };
}).sort((a, b) => b.marketValue - a.marketValue);

const totalMarketValue = positions.reduce((s, p) => s + p.marketValue, 0);
const totalCostBasis = positions.reduce((s, p) => s + p.costBasis, 0);
const totalUnrealizedPL = positions.reduce((s, p) => s + p.unrealizedPL, 0);

positions.forEach(p => {
  p.allocationPercent = totalMarketValue > 0
    ? Math.round((p.marketValue / totalMarketValue) * 10000) / 100
    : 0;
});

const out = {
  updated: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
  source: 'Trading 212 live API',
  currency: (cash && cash.currencyCode) || (info && info.currencyCode) || 'EUR',
  account: info ? {
    id: info.id,
    currencyCode: info.currencyCode
  } : null,
  cash: cash ? {
    free: parseFloat(cash.free) || 0,
    invested: parseFloat(cash.invested) || 0,
    ppl: parseFloat(cash.ppl) || 0,
    result: parseFloat(cash.result) || 0,
    total: parseFloat(cash.total) || 0,
    pieCash: parseFloat(cash.pieCash) || 0,
    blocked: parseFloat(cash.blocked) || 0
  } : null,
  totals: {
    positionCount: positions.length,
    marketValue: Math.round(totalMarketValue * 100) / 100,
    costBasis: Math.round(totalCostBasis * 100) / 100,
    unrealizedPL: Math.round(totalUnrealizedPL * 100) / 100,
    unrealizedPLPct: totalCostBasis > 0 ? Math.round((totalUnrealizedPL / totalCostBasis) * 10000) / 100 : 0,
    accountValue: Math.round(((cash && cash.total) ? parseFloat(cash.total) : (totalMarketValue + (cash ? parseFloat(cash.free) || 0 : 0))) * 100) / 100
  },
  positions
};

await mkdir(new URL('../data/', import.meta.url), { recursive: true });
await writeFile(
  new URL('../data/t212-portfolio.json', import.meta.url),
  JSON.stringify(out, null, 2) + '\n'
);
console.log(`Wrote ${positions.length} positions \u2014 market value \u20AC${out.totals.marketValue}, P/L \u20AC${out.totals.unrealizedPL} (${out.totals.unrealizedPLPct}%)`);
