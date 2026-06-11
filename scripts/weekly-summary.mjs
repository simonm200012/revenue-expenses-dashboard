// Weekly AI-generated finance summary, emailed via Resend.
// Triggered by .github/workflows/weekly-summary.yml every Monday morning.
// Required env: ANTHROPIC_API_KEY, RESEND_API_KEY

const SUPABASE_URL = 'https://nirmwhvdoxujgzkhbhrk.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5pcm13aHZkb3h1amd6a2hiaHJrIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzUzNTA2MjksImV4cCI6MjA5MDkyNjYyOX0.XaYDMPW2hNjlzu31avolGZ2XebjjKs0yX1jFwSmPzB0';
const TO_EMAIL = 'simonm2000@outlook.com';
const FROM_EMAIL = 'Finance Bot <onboarding@resend.dev>';
const DASHBOARD_URL = 'https://simonm200012.github.io/revenue-expenses-dashboard/';
const ANTHROPIC_MODEL = 'claude-sonnet-4-5';

function isoDate(d){return new Date(d).toISOString().slice(0,10);}
function round2(n){return Math.round(n*100)/100;}

const now = new Date();
const dayMs = 86400000;
const sevenDaysAgo  = isoDate(new Date(now - 7  * dayMs));
const fourteenIso   = isoDate(new Date(now - 14 * dayMs));
const thirtyIso     = isoDate(new Date(now - 30 * dayMs));
const sixtyIso      = isoDate(new Date(now - 60 * dayMs));
const nowIso        = isoDate(now);

// Window: we need Jan 1 (YTD recap) AND 6 full prior months (category
// medians), whichever reaches further back.
const yearStart   = nowIso.slice(0,4) + '-01-01';
const curMonth    = nowIso.slice(0,7);
const monthStart  = curMonth + '-01';
const medianStartD = new Date(now); medianStartD.setDate(1); medianStartD.setMonth(medianStartD.getMonth()-6);
const fromIso = isoDate(Math.min(new Date(yearStart).getTime(), medianStartD.getTime()));

// Fetch the whole window from Supabase via REST, paginated — PostgREST
// caps responses at 1000 rows regardless of `limit`, so a single request
// would silently truncate once the window holds more than that.
async function supabaseFetch(){
  const out = [];
  const page = 1000;
  let offset = 0;
  while(true){
    const url = `${SUPABASE_URL}/rest/v1/transactions?date=gte.${fromIso}&order=date.desc&limit=${page}&offset=${offset}`;
    const res = await fetch(url, {
      headers: {
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
        'Accept': 'application/json'
      }
    });
    if(!res.ok){
      console.error('Supabase fetch failed:', res.status, await res.text());
      process.exit(1);
    }
    const rows = await res.json();
    out.push(...rows);
    if(rows.length < page) break;
    offset += page;
  }
  return out;
}

// ---- Helpers ----------------------------------------------------------
function pickRange(rows, fromIso, toIso){
  return rows.filter(t => t.date >= fromIso && t.date < toIso);
}
function n(v){return parseFloat(v||0);}
function cat(r){return r.final_category || r.category || '(uncategorized)';}
function group(rows, keyFn){
  const m = {};
  for(const r of rows){
    const k = keyFn(r);
    if(!m[k]) m[k] = {key:k, count:0, total:0};
    m[k].count++;
    m[k].total += n(r.value);
  }
  return Object.values(m)
    .map(g => ({...g, total: round2(g.total)}))
    .sort((a,b) => b.total - a.total);
}

function summarize(rows){
  const inflow  = rows.filter(t=>t.type==='Inflow').reduce((s,t)=>s+n(t.value),0);
  const outflow = rows.filter(t=>t.type==='Outflow').reduce((s,t)=>s+n(t.value),0);
  const invested= rows.filter(t=>t.type==='Investment').reduce((s,t)=>s+n(t.value),0);
  return {
    inflow: round2(inflow),
    outflow: round2(outflow),
    invested: round2(invested),
    net: round2(inflow-outflow),
    count: rows.length
  };
}

function pctChange(cur, prev){
  if(prev === 0) return cur === 0 ? 0 : null; // null = "n/a"
  return round2((cur-prev) / Math.abs(prev) * 100);
}

// ---- Build context ----------------------------------------------------
const all = await supabaseFetch();
if(all.length === 0){
  console.log('No transactions in the past 90 days. Skipping email.');
  process.exit(0);
}

const lastWeek    = pickRange(all, sevenDaysAgo, nowIso);
const priorWeek   = pickRange(all, fourteenIso, sevenDaysAgo);
const last30      = pickRange(all, thirtyIso, nowIso);
const last60to7   = pickRange(all, sixtyIso, sevenDaysAgo); // for "new merchants" detection

if(lastWeek.length === 0){
  console.log('No transactions in the past week. Skipping email.');
  process.exit(0);
}

const cur  = summarize(lastWeek);
const prev = summarize(priorWeek);
const m30  = summarize(last30);

// 4-week daily averages for context (income/expense per day vs this week's pace)
const dailyAvgInflow30  = round2(m30.inflow / 30);
const dailyAvgOutflow30 = round2(m30.outflow / 30);

// Categories: top 5 expense categories last week + WoW change
const curCatSpend  = group(lastWeek.filter(t=>t.type==='Outflow'), cat);
const prevCatSpend = group(priorWeek.filter(t=>t.type==='Outflow'), cat);
const prevCatMap = Object.fromEntries(prevCatSpend.map(c=>[c.key,c.total]));
const topCategories = curCatSpend.slice(0, 6).map(c => ({
  category: c.key,
  total: c.total,
  count: c.count,
  prevTotal: round2(prevCatMap[c.key] || 0),
  wowPct: pctChange(c.total, prevCatMap[c.key] || 0)
}));

// Categories that grew the most vs prior week (for "spending shifts" insight)
const movers = [];
const allCats = new Set([...curCatSpend.map(c=>c.key), ...prevCatSpend.map(c=>c.key)]);
for(const k of allCats){
  const a = curCatSpend.find(c=>c.key===k)?.total || 0;
  const b = prevCatMap[k] || 0;
  const delta = round2(a - b);
  if(Math.abs(delta) >= 30) movers.push({category: k, prev: b, cur: a, delta});
}
movers.sort((x,y)=> Math.abs(y.delta) - Math.abs(x.delta));
const topMovers = movers.slice(0, 5);

// Top merchants last week
const topMerchants = group(lastWeek.filter(t=>t.type==='Outflow'), r=>r.source||'(no source)')
  .slice(0,5).map(g=>({merchant:g.key, total:g.total, count:g.count}));

// New merchants (first appearance in last 7 days, not seen in 60–7 day window)
const knownMerchants = new Set(last60to7.map(t=>t.source).filter(Boolean));
const newMerchantsRaw = lastWeek.filter(t => t.source && !knownMerchants.has(t.source));
const newMerchantsAgg = group(newMerchantsRaw, r=>r.source||'(no source)').slice(0,5)
  .map(g=>({merchant:g.key, total:g.total, count:g.count, type: newMerchantsRaw.find(t=>t.source===g.key)?.type}));

// Notable transactions: top 8 expenses last week, plus any single charge > €100
const notable = lastWeek
  .filter(t => t.type === 'Outflow')
  .map(t => ({date: t.date, amount: round2(n(t.value)), source: t.source, category: cat(t)}))
  .sort((a,b) => b.amount - a.amount)
  .slice(0, 8);

// Income breakdown by source
const incomeByLabel = group(lastWeek.filter(t=>t.type==='Inflow'),
  r => r.cost_revenue_type || r.source || cat(r));
const incomeSources = incomeByLabel.slice(0, 5).map(g=>({source:g.key, total:g.total, count:g.count}));

// Investment activity by broker
const invByBroker = group(lastWeek.filter(t=>t.type==='Investment'), r=>r.source||'(no source)')
  .map(g=>({broker:g.key, total:g.total, count:g.count}));

// Bank usage breakdown for expenses (which card/bank you used most)
const bankSpend = group(lastWeek.filter(t=>t.type==='Outflow'), r=>r.bank||'(no bank)')
  .slice(0,5).map(g=>({bank:g.key, total:g.total, count:g.count}));

// Day-of-week pattern (which days were heaviest)
const DOW = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
const dowMap = {};
for(const t of lastWeek.filter(t=>t.type==='Outflow')){
  const d = DOW[new Date(t.date).getDay()];
  dowMap[d] = round2((dowMap[d]||0) + n(t.value));
}
const dowBreakdown = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'].map(d => ({day:d, total: dowMap[d]||0}));
const heaviestDay = [...dowBreakdown].sort((a,b)=>b.total-a.total)[0];

// "Big charges" — single transactions > €100 last week
const bigCharges = lastWeek
  .filter(t => t.type === 'Outflow' && n(t.value) > 100)
  .map(t => ({date:t.date, amount: round2(n(t.value)), source:t.source, category:cat(t)}))
  .sort((a,b)=>b.amount-a.amount);

// Spending velocity vs 30-day pace
const weeklyPaceVs30 = {
  expensesThisWeek: cur.outflow,
  expensesAt30dPace: round2(dailyAvgOutflow30 * 7),
  pctVsPace: pctChange(cur.outflow, dailyAvgOutflow30 * 7),
  incomeThisWeek: cur.inflow,
  incomeAt30dPace: round2(dailyAvgInflow30 * 7),
  incomePctVsPace: pctChange(cur.inflow, dailyAvgInflow30 * 7)
};

// ---- Month-to-date cumulative pace vs prior month at the same point ----
const dayOfMonth = now.getDate();
const mtdRows = pickRange(all, monthStart, nowIso);
const mtd = summarize(mtdRows);
const prevMonthStartD = new Date(monthStart + 'T12:00:00Z'); prevMonthStartD.setMonth(prevMonthStartD.getMonth()-1);
const prevMonthStart = isoDate(prevMonthStartD);
const prevSamePointD = new Date(prevMonthStartD); prevSamePointD.setDate(prevSamePointD.getDate() + (dayOfMonth - 1));
const prevMtd = summarize(pickRange(all, prevMonthStart, isoDate(prevSamePointD)));
const monthPace = {
  dayOfMonth,
  spentSoFar: mtd.outflow,
  priorMonthAtSamePoint: prevMtd.outflow,
  pctVsPriorMonth: pctChange(mtd.outflow, prevMtd.outflow),
  incomeSoFar: mtd.inflow
};

// ---- Year-to-date recap ----
const ytdRows = pickRange(all, yearStart, nowIso);
const ytd = summarize(ytdRows);
const ytdSavingsRatePct = ytd.inflow > 0 ? round2((ytd.inflow - ytd.outflow) / ytd.inflow * 100) : null;

// ---- Current month vs 6-month category medians (notable monthly movers) ----
// Compares MTD totals against each category's median over the 6 prior FULL
// months. Early in a month MTD is naturally below median, so only categories
// already EXCEEDING their full-month median are flagged as up.
const monthsBack = [];
for(let i=1;i<=6;i++){
  const d = new Date(monthStart + 'T12:00:00Z'); d.setMonth(d.getMonth()-i);
  monthsBack.push(isoDate(d).slice(0,7));
}
const histByCatMonth = {};
for(const t of all){
  if(t.type !== 'Outflow') continue;
  const m = t.date.slice(0,7);
  if(!monthsBack.includes(m)) continue;
  const c = cat(t);
  histByCatMonth[c] = histByCatMonth[c] || {};
  histByCatMonth[c][m] = round2((histByCatMonth[c][m]||0) + n(t.value));
}
const mtdByCat = group(mtdRows.filter(t=>t.type==='Outflow'), cat);
const monthVsMedian = mtdByCat.map(g => {
  const hist = Object.values(histByCatMonth[g.key]||{}).sort((a,b)=>a-b);
  const median = hist.length ? hist[Math.floor(hist.length/2)] : 0;
  return {category: g.key, mtdTotal: g.total, sixMonthMedian: round2(median), delta: round2(g.total - median)};
}).filter(x => x.sixMonthMedian > 0 && x.delta > 25)
  .sort((a,b) => b.delta - a.delta)
  .slice(0, 4);

const context = {
  thisWeek: cur,
  priorWeek: prev,
  last30Days: m30,
  monthSoFar: { ...mtd, ...monthPace },
  yearToDate: { ...ytd, savingsRatePct: ytdSavingsRatePct },
  monthVsMedian,
  wowChange: {
    income: pctChange(cur.inflow, prev.inflow),
    expenses: pctChange(cur.outflow, prev.outflow),
    net: pctChange(cur.net, prev.net),
    invested: pctChange(cur.invested, prev.invested)
  },
  weeklyPaceVs30,
  topCategoriesLastWeek: topCategories,
  spendingMovers: topMovers,
  topMerchants,
  newMerchants: newMerchantsAgg,
  incomeSources,
  invByBroker,
  bankSpend,
  dowBreakdown,
  heaviestDay,
  bigCharges,
  notableTransactions: notable
};

// ---- Prompt ----------------------------------------------------------
const prompt = `You are writing a thorough but readable weekly personal-finance summary email for the user. Currency is EUR (\u20AC).

Compare the last 7 days (${sevenDaysAgo} \u2192 ${nowIso}) to the prior 7 days (${fourteenIso} \u2192 ${sevenDaysAgo}). You also have 30-day context for pace comparisons.

KEY CONCEPTS:
- "Invested" = money moved into investment accounts. NOT an expense \u2014 user still owns it.
- "Pace" = the rate the user has been spending/earning over the last 30 days, projected to 7 days. Useful to flag a week that's running hot or cold.
- "New merchants" = sources that appeared in the last 7 days but were NOT seen in the prior 53 days. Worth flagging \u2014 either first-time spend or a new subscription.

OUTPUT: Inline HTML email body only (no <html>/<body>/<head>, no markdown). Be specific with numbers. ALWAYS use the Eurosign \u20AC, format thousands with commas (e.g., \u20AC1,234.56), and round to 2 decimals.

STRUCTURE (use exactly these sections, in order, but skip any section where data is empty/zero):

1. <h2>Headline</h2>
   One short paragraph (2 sentences max) with the week's most important finding. State whether the week was a surplus or deficit, and what's notable (highest spend ever? big new merchant? big income spike?).

2. <h2>The numbers</h2>
   A stat row with 4 inline-flex boxes (income / expenses / net / invested). Each box uses this template:
   <div style="flex:1;min-width:120px;padding:12px 14px;border-radius:10px;background:#f1f5f9;border:1px solid #e2e8f0">
     <div style="font-size:10px;text-transform:uppercase;letter-spacing:1px;color:#64748b;font-weight:700">LABEL</div>
     <div style="font-size:20px;font-weight:800;color:#COLOR;margin-top:4px">\u20ACVALUE</div>
     <div style="font-size:11px;color:#64748b;margin-top:2px">vs prev: BADGE</div>
   </div>
   Wrap them in: <div style="display:flex;gap:10px;margin:12px 0;flex-wrap:wrap">...</div>
   Use #10b981 for income, #ef4444 for expenses, #06b6d4 (or red if deficit) for net, #8b5cf6 for invested.
   Skip the invested box if invested = 0 last week.

3. <h2>Vs your 30-day pace</h2>
   2-3 sentences explaining whether this week was hotter or cooler than your average pace. Reference the actual numbers: "Spent \u20ACX vs your typical 7-day pace of \u20ACY (Z% above/below)".

4. <h2>Month & year so far</h2>
   2-3 sentences from monthSoFar + yearToDate: whether this month's cumulative spend (\u20ACX by day N) is running above or below last month at the same point (\u20ACY, Z%), then a one-line YTD recap (income, expenses, net, savings rate). If monthVsMedian is non-empty, name the single category most clearly blowing past its 6-month median with figures (note: those are month-to-date totals already EXCEEDING a full-month median \u2014 that's why they're notable).

5. <h2>Top spending categories</h2>
   <ul> with the top 5 categories. For each: "<strong>Category name</strong> \u2014 \u20ACamount across N transactions (WoW% badge)". Use green for declines, red for big growth.

6. <h2>Spending shifts</h2>
   ONLY include this section if there are categories with significant week-over-week swings (provided in spendingMovers). Highlight 2-4 categories that grew or shrank the most, with concrete numbers: "<strong>Groceries</strong> +\u20AC85 vs last week (€220 \u2192 €305)".

7. <h2>Notable transactions</h2>
   <ul> of 3-5 of the largest or most unusual single transactions. Format: "<strong>Source</strong> on date \u2014 \u20ACamount (Category)".

8. <h2>New merchants this week</h2>
   ONLY if newMerchants is non-empty. Brief list: "<strong>Merchant</strong> \u2014 \u20ACamount (N charge(s))". Add a one-line note like "Worth checking these \u2014 either first-time spend or a new subscription you may want to track."

9. <h2>Income breakdown</h2>
   ONLY if income > 0 last week. List income sources from incomeSources. Format: "<strong>Source</strong> \u2014 \u20ACamount".

10. <h2>Investment activity</h2>
   ONLY if invested > 0 last week. List by broker: "<strong>Broker</strong> \u2014 \u20ACamount across N contribution(s)". Add a one-sentence reflection on whether they're keeping up their investment habit.

11. <h2>One thing to act on</h2>
    A SINGLE concrete, actionable recommendation tied to something specific in the data above. Examples: "Cancel the X subscription you haven't used", "Your grocery spend is up 30% \u2014 check if a price hike or behavior change", "Net is down 3 weeks running, consider trimming Y", "You're on pace to invest €X this month if you keep this up".

Keep paragraphs short (1-2 sentences). Aim for ~450-650 words total. Use only the styles in the structure above plus:
- <p style="margin:0 0 10px 0;line-height:1.55;color:#334155;font-size:14px">
- <ul style="margin:0 0 14px 0;padding-left:20px;color:#334155;font-size:14px;line-height:1.7">
- <h2 style="color:#10b981;font-size:17px;margin:20px 0 8px 0;border-bottom:1px solid #e2e8f0;padding-bottom:4px">
- WoW badge pos: <span style="background:#dcfce7;color:#15803d;padding:1px 7px;border-radius:10px;font-size:11px;font-weight:600">+12.3%</span>
- WoW badge neg: <span style="background:#fee2e2;color:#b91c1c;padding:1px 7px;border-radius:10px;font-size:11px;font-weight:600">-12.3%</span>
- WoW badge neutral: <span style="background:#e2e8f0;color:#475569;padding:1px 7px;border-radius:10px;font-size:11px;font-weight:600">flat</span>

Don't add a sign-off, signature, or "Have a great week" \u2014 keep it data-focused.

DATA:
${JSON.stringify(context, null, 2)}`;

const aiRes = await fetch('https://api.anthropic.com/v1/messages', {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    'x-api-key': process.env.ANTHROPIC_API_KEY,
    'anthropic-version': '2023-06-01'
  },
  body: JSON.stringify({
    model: ANTHROPIC_MODEL,
    max_tokens: 4096,
    messages: [{role: 'user', content: prompt}]
  })
});

if(!aiRes.ok){
  console.error('Anthropic API error:', aiRes.status, await aiRes.text());
  process.exit(1);
}
const aiData = await aiRes.json();
const summaryHtml = (aiData.content || [])
  .filter(b => b.type === 'text')
  .map(b => b.text)
  .join('')
  .trim();

if(!summaryHtml){
  console.error('Empty AI response');
  process.exit(1);
}

const dateLabel = new Date().toLocaleDateString('en-GB', {weekday:'long', day:'numeric', month:'long', year:'numeric'});
const subject = `Weekly Finance Summary \u2014 ${nowIso} \u00B7 \u20AC${Math.round(cur.net).toLocaleString('en-GB')} ${cur.net>=0?'surplus':'deficit'}`;

const emailHtml = `<!DOCTYPE html>
<html><body style="font-family:Helvetica,Arial,sans-serif;background:#f8fafc;margin:0;padding:24px;color:#1e293b">
<div style="max-width:640px;margin:0 auto;background:#fff;border-radius:14px;overflow:hidden;box-shadow:0 4px 16px rgba(0,0,0,0.08)">
  <div style="padding:24px 28px;background:linear-gradient(135deg,#10b981 0%,#06b6d4 50%,#8b5cf6 100%);color:#fff">
    <div style="font-size:11px;text-transform:uppercase;letter-spacing:1.5px;opacity:.85;font-weight:600">Weekly Summary</div>
    <h1 style="margin:6px 0 0 0;font-size:24px;font-weight:800;letter-spacing:-0.5px">Revenue &amp; Expenses</h1>
    <p style="margin:6px 0 0 0;opacity:.85;font-size:13px">${dateLabel} \u00B7 ${lastWeek.length} txns this week</p>
  </div>
  <div style="padding:8px 28px 24px 28px">
    ${summaryHtml}
  </div>
  <div style="padding:14px 28px;background:#f1f5f9;border-top:1px solid #e2e8f0;color:#64748b;font-size:11px;text-align:center">
    <a href="${DASHBOARD_URL}" style="color:#10b981;text-decoration:none;font-weight:600">Open dashboard \u2192</a>
    &nbsp;\u00B7&nbsp; Generated by Claude (${ANTHROPIC_MODEL}) over ${all.length} transactions since ${fromIso}
  </div>
</div>
</body></html>`;

const resendRes = await fetch('https://api.resend.com/emails', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${process.env.RESEND_API_KEY}`
  },
  body: JSON.stringify({
    from: FROM_EMAIL,
    to: [TO_EMAIL],
    subject,
    html: emailHtml
  })
});

const resendBody = await resendRes.text();
if(!resendRes.ok){
  console.error('Resend API error:', resendRes.status, resendBody);
  process.exit(1);
}
console.log('Email sent successfully:', resendBody);
