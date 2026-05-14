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
function fmtEur(n){return '\u20AC'+Math.round(n).toLocaleString('en-GB');}

const now = new Date();
const sevenDaysAgo = new Date(now.getTime() - 7*86400000);
const fourteenDaysAgo = new Date(now.getTime() - 14*86400000);

const sevenIso = isoDate(sevenDaysAgo);
const fourteenIso = isoDate(fourteenDaysAgo);
const nowIso = isoDate(now);

// Fetch last 14 days from Supabase via REST
async function supabaseFetch(){
  const url = `${SUPABASE_URL}/rest/v1/transactions?date=gte.${fourteenIso}&order=date.desc&limit=2000`;
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
  return res.json();
}

function summarize(rows){
  const inflow = rows.filter(t=>t.type==='Inflow').reduce((s,t)=>s+parseFloat(t.value||0),0);
  const outflow = rows.filter(t=>t.type==='Outflow').reduce((s,t)=>s+parseFloat(t.value||0),0);
  const invested = rows.filter(t=>t.type==='Investment').reduce((s,t)=>s+parseFloat(t.value||0),0);
  const byCat = {};
  rows.filter(t=>t.type==='Outflow').forEach(t=>{
    const c = t.final_category || t.category || '(uncategorized)';
    byCat[c] = (byCat[c]||0) + parseFloat(t.value||0);
  });
  const topCats = Object.entries(byCat)
    .map(([k,v])=>({category:k, total:Math.round(v*100)/100}))
    .sort((a,b)=>b.total-a.total)
    .slice(0,5);
  return {
    inflow: Math.round(inflow*100)/100,
    outflow: Math.round(outflow*100)/100,
    invested: Math.round(invested*100)/100,
    net: Math.round((inflow-outflow)*100)/100,
    count: rows.length,
    topCategories: topCats
  };
}

const all = await supabaseFetch();
const lastWeek = all.filter(t => t.date >= sevenIso && t.date < nowIso);
const priorWeek = all.filter(t => t.date >= fourteenIso && t.date < sevenIso);

const curStats = summarize(lastWeek);
const prevStats = summarize(priorWeek);

// Notable transactions: top 10 expenses by amount last week
const notable = lastWeek
  .filter(t => t.type === 'Outflow')
  .map(t => ({
    date: t.date,
    amount: parseFloat(t.value),
    source: t.source,
    category: t.final_category || t.category
  }))
  .sort((a,b) => b.amount - a.amount)
  .slice(0, 10);

if(lastWeek.length === 0){
  console.log('No transactions in the past week. Skipping email.');
  process.exit(0);
}

const prompt = `You are writing a friendly, concise weekly personal-finance summary email. Currency is EUR (\u20AC).

Compare the last 7 days (${sevenIso} to ${nowIso}) to the prior 7 days (${fourteenIso} to ${sevenIso}).

NOTE: "invested" = money moved into investment accounts. It is NOT an expense \u2014 the user still owns it. Treat it as a separate flow.

Produce ONLY the email body as inline HTML (no <html>, <body>, <head>, or markdown). Use these styles inline:
- Headings: <h2 style="color:#10b981;font-size:18px;margin:18px 0 8px 0">
- Body text: <p style="margin:0 0 10px 0;line-height:1.5;color:#334155;font-size:14px">
- Lists: <ul style="margin:0 0 12px 0;padding-left:20px;color:#334155;font-size:14px;line-height:1.6">
- Strong green for positive: <strong style="color:#10b981">
- Strong red for negative: <strong style="color:#ef4444">
- Strong purple for invested: <strong style="color:#8b5cf6">
- Stat row: <div style="display:flex;gap:12px;margin:12px 0;flex-wrap:wrap">

Sections to include:
1. One short opening sentence with the week's headline finding.
2. Stat row: Income, Expenses, Net (vs prior week % change). If invested > 0 last week, add a 4th box for "Invested".
3. Top spending categories (3-5).
4. 2-3 notable transactions worth flagging (largest, unusual, or first-time merchants).
5. One actionable observation or recommendation.

Aim for 200-280 words total. Be specific with numbers. Don't add a sign-off or signature \u2014 that's added later.

DATA:
Last 7 days: ${JSON.stringify(curStats)}
Prior 7 days: ${JSON.stringify(prevStats)}
Notable transactions: ${JSON.stringify(notable)}`;

const aiRes = await fetch('https://api.anthropic.com/v1/messages', {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    'x-api-key': process.env.ANTHROPIC_API_KEY,
    'anthropic-version': '2023-06-01'
  },
  body: JSON.stringify({
    model: ANTHROPIC_MODEL,
    max_tokens: 1500,
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
const subject = `Weekly Finance Summary \u2014 ${nowIso}`;

const emailHtml = `<!DOCTYPE html>
<html><body style="font-family:Helvetica,Arial,sans-serif;background:#f8fafc;margin:0;padding:24px;color:#1e293b">
<div style="max-width:600px;margin:0 auto;background:#fff;border-radius:14px;overflow:hidden;box-shadow:0 4px 16px rgba(0,0,0,0.08)">
  <div style="padding:24px 28px;background:linear-gradient(135deg,#10b981 0%,#06b6d4 50%,#8b5cf6 100%);color:#fff">
    <div style="font-size:11px;text-transform:uppercase;letter-spacing:1.5px;opacity:.85;font-weight:600">Weekly Summary</div>
    <h1 style="margin:6px 0 0 0;font-size:24px;font-weight:800;letter-spacing:-0.5px">Revenue &amp; Expenses</h1>
    <p style="margin:6px 0 0 0;opacity:.85;font-size:13px">${dateLabel}</p>
  </div>
  <div style="padding:8px 28px 24px 28px">
    ${summaryHtml}
  </div>
  <div style="padding:14px 28px;background:#f1f5f9;border-top:1px solid #e2e8f0;color:#64748b;font-size:11px;text-align:center">
    <a href="${DASHBOARD_URL}" style="color:#10b981;text-decoration:none;font-weight:600">Open dashboard \u2192</a>
    &nbsp;\u00B7&nbsp; Generated by Claude (${ANTHROPIC_MODEL})
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
