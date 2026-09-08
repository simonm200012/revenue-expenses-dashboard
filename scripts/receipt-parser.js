/* Receipt text parsing is deliberately conservative: uncertain fields stay blank. */
(function(root){
  'use strict';
  function amount(text){
    let value=String(text).replace(/[€$£\s']/g,'');
    if(!/^-?\d[\d.,]*$/.test(value)) return null;
    const decimal=Math.max(value.lastIndexOf(','),value.lastIndexOf('.'));
    if(decimal>=0){
      if(value.length-decimal-1!==2) return null;
      value=value.slice(0,decimal).replace(/[.,]/g,'')+'.'+value.slice(decimal+1);
    }
    const n=Number(value);
    return Number.isFinite(n)?Math.round(n*100)/100:null;
  }
  function isoDate(y,m,d){
    y=Number(y);m=Number(m);d=Number(d);
    if(y<100)y+=2000;
    const date=new Date(Date.UTC(y,m-1,d));
    return y>=2000&&y<=2100&&date.getUTCFullYear()===y&&date.getUTCMonth()===m-1&&date.getUTCDate()===d
      ?`${y}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}`:'';
  }
  function parse(text){
    const lines=String(text||'').split(/\r?\n/).map(s=>s.trim()).filter(Boolean);
    let date='',merchant='',candidates=[];
    for(let i=0;i<lines.length;i++){
      const line=lines[i];
      if(!date){
        const ymd=line.match(/\b(20\d{2})[-/.](\d{1,2})[-/.](\d{1,2})\b/);
        const dmy=line.match(/\b(\d{1,2})\s*[./-]\s*(\d{1,2})\s*[./-]\s*(20\d{2}|\d{2})\b/);
        if(ymd)date=isoDate(ymd[1],ymd[2],ymd[3]);
        else if(dmy)date=isoDate(dmy[3],dmy[2],dmy[1]);
      }
      // Avoid confusing subtotal, tender, change, VAT or savings with the cost.
      const total=/\b(grand\s+total|amount\s+due|total\s+due|za\s+pla[cč]ilo|za\s+placilo|skupaj|total|znesek\s+ra[cč]una)\b/i.test(line);
      const excluded=/\b(sub[ -]?total|vmesni|ddv|vat|tax|change|vra[cč]ilo|prihran|popust|discount|gotovina|cash|tender|received)\b/i.test(line);
      if(total&&!excluded){
        const values=line.match(/-?\d(?:[\d.,\s']*\d)?[.,]\d{2}(?!\d)/g)||[];
        // Some tills print the total on the immediately following line.
        if(!values.length&&lines[i+1]&&/^\s*(?:EUR|€)?\s*\d[\d.,\s]*\s*(?:EUR|€)?\s*$/i.test(lines[i+1])){
          values.push(lines[i+1].replace(/EUR/ig,''));
        }
        const n=amount(values[values.length-1]);
        if(n!==null&&n>0)candidates.push({value:n,score:/grand|due|za\s+pla|znesek/i.test(line)?2:1});
      }
    }
    merchant=lines.slice(0,6).find(s=>/[a-zA-ZčšžČŠŽ]{3}/.test(s)&&!/(receipt|ra[cč]un|invoice|dobrodo|welcome|datum|date|www\.|https?:|tel\b|dav[cč]|ddv|vat|\bsi\d|\d{3,})/i.test(s))||'';
    const best=candidates.sort((a,b)=>b.score-a.score)[0];
    const highest=best?candidates.filter(c=>c.score===best.score):[];
    const ambiguous=new Set(highest.map(c=>c.value)).size>1;
    const currency=/\b(USD|GBP|CHF|HRK|HUF|CZK|PLN)\b|[$£]/i.test(text)?'other':'EUR';
    return {merchant:merchant.slice(0,160),date,amount:ambiguous||currency!=='EUR'?null:best?.value??null,ambiguous,currency};
  }
  function duplicateCandidates(rows,entry,excludedId){
    const cents=Math.round(entry.v*100);
    return rows.filter(row=>String(row.id)!==String(excludedId)&&row.d===entry.d&&row.t===entry.t&&Math.round(row.v*100)===cents);
  }
  const api={amount,isoDate,parse,duplicateCandidates};
  if(typeof module!=='undefined'&&module.exports)module.exports=api;
  else root.ReceiptParser=api;
})(typeof window!=='undefined'?window:globalThis);
