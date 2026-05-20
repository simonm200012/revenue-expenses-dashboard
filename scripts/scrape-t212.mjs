// Fetches the Trading 212 portfolio + cash balance and writes them to
// data/t212-portfolio.json. Runs from .github/workflows/scrape-t212.yml.
//
// Required env: T212_API_KEY (stored as a GitHub Actions secret).
// T212 uses the API key directly as the Authorization header value (no "Bearer ").

import { writeFile, mkdir } from 'node:fs/promises';

// Trim whitespace — GitHub secrets sometimes pick up a trailing newline on paste.
const API_KEY = (process.env.T212_API_KEY || '').trim();
const API_SECRET = (process.env.T212_API_SECRET || '').trim();
if (!API_KEY || !API_SECRET) {
  console.error('Missing T212_API_KEY or T212_API_SECRET env variable.');
  console.error('T212 beta API uses HTTP Basic auth — you need BOTH secrets.');
  process.exit(1);
}
const keyHint = API_KEY.length >= 8 ? `${API_KEY.slice(0,4)}...${API_KEY.slice(-4)} (length ${API_KEY.length})` : `(${API_KEY.length} chars)`;
const secHint = API_SECRET.length >= 8 ? `${API_SECRET.slice(0,4)}...${API_SECRET.slice(-4)} (length ${API_SECRET.length})` : `(${API_SECRET.length} chars)`;
console.log('Using API key:', keyHint);
console.log('Using API secret:', secHint);

const ENV = (process.env.T212_ENV || 'live').toLowerCase();
const BASE = ENV === 'demo'
  ? 'https://demo.trading212.com'
  : 'https://live.trading212.com';
console.log('Environment:', ENV, BASE);

// HTTP Basic Auth: base64(KEY:SECRET)
const BASIC = Buffer.from(`${API_KEY}:${API_SECRET}`).toString('base64');
const HEADERS = { Authorization: `Basic ${BASIC}`, Accept: 'application/json' };

async function t212(path) {
  const res = await fetch(BASE + path, { headers: HEADERS });
  if (!res.ok) {
    const body = await res.text();
    const errMsg = `${path} -> HTTP ${res.status}: ${body.slice(0, 300)}`;
    if (res.status === 401) {
      throw new Error(errMsg + '\n  \u2192 Possible causes: wrong KEY/SECRET combination, key generated for Demo (set T212_ENV=demo), or whitespace in secrets.');
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

// T212 reports per-position averagePrice / currentPrice in the instrument's
// NATIVE currency (pence for UK stocks, USD for US, EUR for EU). The only
// per-position field already in account currency (EUR) is `ppl`.
// The cash object holds correct totals in EUR:
//   cash.invested = total cost basis (EUR)
//   cash.ppl      = total unrealized P/L (EUR)
//   cash.free     = available cash (EUR)
//   cash.pieCash  = cash held in pies (EUR)
//   cash.total    = free + invested + pieCash + ppl (full account value)
// So we use the cash object for portfolio-level totals, and derive each
// position's EUR cost/value by pro-rating the EUR total by the position's
// native-currency cost basis ratio. Per-position ppl stays as reported.

const nativeRows = (Array.isArray(portfolio) ? portfolio : []).map(p => {
  const qty = parseFloat(p.quantity) || 0;
  const avg = parseFloat(p.averagePrice) || 0;
  const cur = parseFloat(p.currentPrice) || 0;
  const nativeCost = qty * avg;
  const nativeValue = qty * cur;
  const ppl = (p.ppl !== undefined && p.ppl !== null) ? parseFloat(p.ppl) : 0;
  return {
    raw: p, qty, avg, cur, nativeCost, nativeValue, ppl,
    fxPpl: parseFloat(p.fxPpl) || 0
  };
});

const cashInvested = cash ? parseFloat(cash.invested) || 0 : 0;   // EUR cost basis total
const cashPpl      = cash ? parseFloat(cash.ppl)      || 0 : 0;   // EUR total P/L
const cashFree     = cash ? parseFloat(cash.free)     || 0 : 0;
const cashPie      = cash ? parseFloat(cash.pieCash)  || 0 : 0;
const cashBlocked  = cash ? parseFloat(cash.blocked)  || 0 : 0;
const cashTotal    = cash ? parseFloat(cash.total)    || 0 : (cashFree + cashInvested + cashPpl + cashPie);
const totalEURMarketValue = cashInvested + cashPpl;
const totalNativeCost = nativeRows.reduce((s, r) => s + r.nativeCost, 0);

// Pro-rate each position's EUR cost basis from its native cost share.
// Then EUR market value = EUR cost + per-position EUR ppl.
const positions = nativeRows.map(r => {
  const share = totalNativeCost > 0 ? r.nativeCost / totalNativeCost : 0;
  const eurCost = cashInvested * share;
  const eurValue = eurCost + r.ppl;
  return {
    ticker: r.raw.ticker || '',
    quantity: r.qty,
    averagePrice: r.avg,        // in instrument's native currency
    currentPrice: r.cur,        // in instrument's native currency
    nativeCurrencyValue: Math.round(r.nativeValue * 100) / 100,
    costBasis: Math.round(eurCost * 100) / 100,        // EUR
    marketValue: Math.round(eurValue * 100) / 100,     // EUR
    unrealizedPL: Math.round(r.ppl * 100) / 100,       // EUR (from T212)
    unrealizedPLPct: eurCost > 0 ? Math.round((r.ppl / eurCost) * 10000) / 100 : 0,
    fxPpl: r.fxPpl,
    initialFillDate: r.raw.initialFillDate || '',
    pieQuantity: parseFloat(r.raw.pieQuantity) || 0,
    frontend: r.raw.frontend || ''
  };
}).sort((a, b) => b.marketValue - a.marketValue);

positions.forEach(p => {
  p.allocationPercent = totalEURMarketValue > 0
    ? Math.round((p.marketValue / totalEURMarketValue) * 10000) / 100
    : 0;
});

const totalMarketValue = totalEURMarketValue;
const totalCostBasis = cashInvested;
const totalUnrealizedPL = cashPpl;

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
    accountValue: Math.round(cashTotal * 100) / 100
  },
  positions
};

await mkdir(new URL('../data/', import.meta.url), { recursive: true });
await writeFile(
  new URL('../data/t212-portfolio.json', import.meta.url),
  JSON.stringify(out, null, 2) + '\n'
);
console.log(`Wrote ${positions.length} positions \u2014 market value \u20AC${out.totals.marketValue}, P/L \u20AC${out.totals.unrealizedPL} (${out.totals.unrealizedPLPct}%)`);
