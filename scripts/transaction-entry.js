/* App entry, receipt review and durable per-import corrections. No AI API calls. */
let entryEdit=null,entryToken='',entryBusy=false,receiptRun=0,receiptWorker=null,receiptURL='',entryReturnFocus=null;
let importedEdits=new Map();
function entryText(en,sl){return typeof CURRENT_LANG!=='undefined'&&CURRENT_LANG==='sl'?sl:en;}
function localToday(){const d=new Date();return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;}
function entryStatus(message,error=false){const node=document.getElementById('qaStatus');node.textContent=message;node.style.color=error?'var(--acc-red,#ef4444)':'var(--text3)';}
function entryLock(locked){entryBusy=locked;document.querySelectorAll('#quickAddPanel input,#quickAddPanel select,#quickAddPanel button').forEach(e=>{e.disabled=locked;});}
function cleanTransactionFields(value){
  if(!value||typeof value!=='object'||Array.isArray(value))return null;
  const date=String(value.date||'');
  if(!/^\d{4}-\d{2}-\d{2}$/.test(date)||ReceiptParser.isoDate(...date.split('-'))!==date||!Number.isFinite(value.value)||value.value<=0||!['Inflow','Outflow','Investment'].includes(value.type)||typeof value.source!=='string'||!value.source.trim())return null;
  const out={date,value:Math.round(value.value*100)/100,type:value.type};
  for(const key of ['source','bank','category','final_category','cost_revenue_type'])out[key]=typeof value[key]==='string'?value[key].slice(0,500):null;
  return out;
}
async function loadTransactionEdits(){
  const edits=new Map();
  for(let from=0;;from+=1000){
    const {data,error}=await _supabase.from('app_state').select('key,value').like('key','txn-edit:%').order('key').range(from,from+999);
    if(error)throw new Error(entryText('Could not load saved corrections. Please retry.','Popravkov ni bilo mogoče naložiti. Poskusite znova.'));
    for(const row of data||[]){const fields=cleanTransactionFields(row.value?.fields);if(fields)edits.set(row.key.slice(9),fields);}
    if(!data||data.length<1000)break;
  }
  importedEdits=edits;
}
// The database applies corrections atomically. Never overlay stale browser values on a newer server row.
function effectiveTransaction(row){return importedEdits.has(row.row_hash)?{...row,_edited:true}:row;}
async function refreshSyncStatus(){
  const node=document.getElementById('sheetsSyncStatus');if(!node)return;
  try{
    const {data,error}=await _supabase.from('app_state').select('value').eq('key','fin-sheets-sync').maybeSingle();
    if(error)throw error;
    const s=data?.value;
    if(!s){node.textContent=entryText('Sheets import: daily, 06:00–07:00 Ljubljana. Awaiting status.','Uvoz iz preglednice: dnevno, 6.00–7.00. Čakam stanje.');return;}
    const when=new Date(s.finished_at||s.started_at);
    const stamp=Number.isFinite(when.getTime())?when.toLocaleString(typeof CURRENT_LANG!=='undefined'&&CURRENT_LANG==='sl'?'sl-SI':'en-GB',{dateStyle:'short',timeStyle:'short',timeZone:'Europe/Ljubljana'}):'';
    const stale=Date.now()-when.getTime()>36*3600000;
    const interrupted=s.status==='running'&&Date.now()-when.getTime()>10*60000;
    node.textContent=s.status==='success'?entryText(`Sheets synced ${stamp}${stale?' · Overdue':''}`,`Preglednica posodobljena ${stamp}${stale?' · Zamuja':''}`):s.status==='running'&&!interrupted?entryText('Sheets import running…','Uvoz preglednice poteka…'):entryText(`Sheets import needs attention · ${stamp}`,`Uvoz preglednice potrebuje pregled · ${stamp}`);
    node.style.color=s.status==='success'&&!stale?'var(--text4)':'var(--acc-amber)';
    node.title=entryText('Daily 06:00–07:00 Europe/Ljubljana. App entries save immediately.','Dnevno 6.00–7.00 Europe/Ljubljana. Vnosi v aplikaciji se shranijo takoj.');
  }catch{node.textContent=entryText('Sheets sync status unavailable','Stanje uvoza ni na voljo');}
}
function clearReceipt(){
  activeReceiptId=null;
  document.getElementById('qaReceiptMatches').replaceChildren();
  receiptRun++;
  if(receiptWorker){receiptWorker.terminate().catch(()=>{});receiptWorker=null;}
  if(receiptURL){URL.revokeObjectURL(receiptURL);receiptURL='';}
  for(const id of ['receiptFile','receiptCamera'])document.getElementById(id).value='';
  document.getElementById('receiptPreview').removeAttribute('src');
  document.getElementById('receiptReview').hidden=true;
  document.getElementById('receiptConfirmed').checked=false;
  document.getElementById('receiptText').textContent='';
  document.getElementById('receiptStatus').textContent='';
}
function openQuickAdd(id){
  if(entryBusy)return;
  entryReturnFocus=document.activeElement;
  entryEdit=id!=null?ORIGINAL_TXNS.find(t=>String(t.id)===String(id)):null;
  if(id!=null&&!entryEdit){entryStatus('This entry could not be found. Reload and try again.',true);return;}
  entryToken='app:'+crypto.randomUUID();
  clearReceipt();
  const banks=[...new Set(['Cash',...TXNS.map(t=>t.b).filter(Boolean)])].sort();
  document.getElementById('qaBank').innerHTML=banks.map(b=>`<option value="${escapeHtml(b)}">${escapeHtml(b)}</option>`).join('');
  document.getElementById('qaCategoryList').innerHTML=[...new Set(TXNS.map(t=>t.c).filter(Boolean))].sort().map(c=>`<option value="${escapeHtml(c)}">`).join('');
  for(const [id,key]of [['qaDate','d'],['qaAmount','v'],['qaSource','s'],['qaCategory','c'],['qaDetail','r']])document.getElementById(id).value=entryEdit?.[key]??(id==='qaDate'?localToday():'');
  document.getElementById('qaBank').value=entryEdit?.b||'Cash';
  setChipState('qaTypeChips',entryEdit?.t||'Out');
  document.getElementById('qaTitle').textContent=entryEdit?entryText('Edit transaction','Uredi transakcijo'):entryText('Add transaction','Dodaj transakcijo');
  document.getElementById('qaSave').textContent=entryEdit?entryText('Save changes','Shrani spremembe'):entryText('Save transaction','Shrani transakcijo');
  document.getElementById('qaReset').hidden=!!entryEdit;
  document.getElementById('qaEditNote').hidden=!entryEdit;
  document.getElementById('qaDuplicate').hidden=true;
  document.getElementById('qaDuplicateConfirmed').checked=false;
  entryStatus('');
  document.getElementById('qaHistory').replaceChildren();document.getElementById('qaHistory').hidden=true;
  document.getElementById('qaManage').hidden=!entryEdit;
  document.getElementById('qaAttached').innerHTML=entryEdit?FINANCE_RECEIPTS.filter(r=>String(r.transaction_id)===String(entryEdit.id)).map(r=>`<button class="page-btn" data-id="${escapeHtml(r.id)}" onclick="viewPrivateReceipt(this.dataset.id)">View ${escapeHtml(r.original_name)}</button>`).join(''):'';
  document.getElementById('quickAddPanel').classList.add('open');
  document.getElementById('quickAddPanel').setAttribute('aria-hidden','false');
  document.getElementById('quickAddOverlay').classList.add('open');
  document.getElementById('qaAmount').focus();
}
function closeQuickAdd(){
  if(entryBusy)return;
  clearReceipt();
  document.getElementById('quickAddPanel').classList.remove('open');
  document.getElementById('quickAddPanel').setAttribute('aria-hidden','true');
  document.getElementById('quickAddOverlay').classList.remove('open');
  entryReturnFocus?.focus();
}
function resetQuickAdd(){if(!entryBusy)openQuickAdd();}
function entryValues(){
  return {d:document.getElementById('qaDate').value,v:Number(document.getElementById('qaAmount').value),s:document.getElementById('qaSource').value.trim(),b:document.getElementById('qaBank').value||'Cash',t:getChipVal('qaTypeChips')||'Out',c:document.getElementById('qaCategory').value.trim()||'Uncategorized',r:document.getElementById('qaDetail').value.trim()};
}
function checkEntryDuplicates(){
  const candidates=ReceiptParser.duplicateCandidates(TXNS,entryValues(),entryEdit?.id);
  const node=document.getElementById('qaDuplicate');node.hidden=!candidates.length;
  document.getElementById('qaDuplicateList').innerHTML=candidates.slice(0,5).map(t=>`<li>${escapeHtml(t.s)} · ${escapeHtml(t.b)} · €${t.v.toFixed(2)} <button type="button" class="page-btn" data-entry-id="${escapeHtml(t.id)}" onclick="openQuickAdd(this.dataset.entryId)">${entryText('Edit existing','Uredi obstoječo')}</button></li>`).join('');
  return candidates;
}
async function saveQuickAdd(){
  if(entryBusy)return;
  const e=entryValues(),type=e.t==='In'?'Inflow':e.t==='Inv'?'Investment':'Outflow';
  const fields=cleanTransactionFields({date:e.d,value:e.v,source:e.s,bank:e.b,type,category:e.c,final_category:e.c,cost_revenue_type:e.r});
  if(!fields){entryStatus(entryText('Enter a valid date, a positive amount and a merchant.','Vnesite veljaven datum, pozitiven znesek in trgovca.'),true);return;}
  if(!document.getElementById('receiptReview').hidden&&!document.getElementById('receiptConfirmed').checked){entryStatus(entryText('Check the receipt and confirm the details before saving.','Pred shranjevanjem preverite račun in potrdite podatke.'),true);return;}
  if(checkEntryDuplicates().length&&!document.getElementById('qaDuplicateConfirmed').checked){entryStatus(entryText('A matching amount is already recorded on this date. Review it below.','Na ta datum je že vpisan enak znesek. Preverite spodaj.'),true);return;}
  entryLock(true);entryStatus(tr('qa.saving'));
  try{
    const {data:result,error}=await _supabase.rpc('finance_save_entry',{p_fields:fields,p_id:entryEdit?.id??null,p_token:entryToken,p_expected:entryEdit?.updated_at??null,p_receipt:activeReceiptId});
    if(error)throw error;
    if(!result?.transaction?.id)throw new Error('The server did not confirm the save. Please retry.');
    acceptSavedTransaction(result.transaction);
    if(activeReceiptId)await refreshPrivateWorkflows();
    entryLock(false);closeQuickAdd();render();
    offerUndo(result,result.already_linked?'This receipt was already recorded.':'Saved. You can edit it from Transactions.');
  }catch(err){entryLock(false);entryStatus(tr('qa.error',{e:err.message||String(err)}),true);}
}
let ocrLibraryPromise;
function loadReceiptLibrary(){
  if(window.Tesseract)return Promise.resolve();
  if(!ocrLibraryPromise)ocrLibraryPromise=new Promise((resolve,reject)=>{
    const script=document.createElement('script');script.src=new URL('vendor/tesseract/tesseract.min.js',document.baseURI).href;
    script.onload=resolve;script.onerror=()=>{script.remove();ocrLibraryPromise=null;reject(new Error('Receipt scanner could not load. Check your connection and retry.'));};document.head.append(script);
  });return ocrLibraryPromise;
}
async function scanReceipt(file){if(file)await uploadReceiptBatch([file]);}
document.addEventListener('DOMContentLoaded',()=>{
  const panel=document.getElementById('quickAddPanel');
  panel.addEventListener('input',event=>{if(event.target.id!=='qaDuplicateConfirmed'&&event.target.id!=='receiptConfirmed'){document.getElementById('qaDuplicateConfirmed').checked=false;document.getElementById('qaDuplicate').hidden=true;}});
  panel.addEventListener('keydown',event=>{
    if(event.key==='Escape'){event.preventDefault();closeQuickAdd();}
    if(event.key==='Tab'){
      const nodes=[...panel.querySelectorAll('button,input,select,summary,[tabindex="0"]')].filter(n=>!n.disabled&&n.getClientRects().length);
      const first=nodes[0],last=nodes[nodes.length-1];
      if(event.shiftKey&&document.activeElement===first){event.preventDefault();last?.focus();}else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first?.focus();}
    }
  });
});
