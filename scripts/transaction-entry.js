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
function effectiveTransaction(row){const fields=importedEdits.get(row.row_hash);return fields?{...row,...fields,_edited:true}:row;}
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
    let saved;
    if(entryEdit){
      // Store imported corrections before updating the row. The daily import
      // re-applies this record, so a later Sheets run cannot undo an app edit.
      if(entryEdit.hash&&!entryEdit.hash.startsWith('app:')){
        const {error}=await _supabase.from('app_state').upsert({key:'txn-edit:'+entryEdit.hash,value:{fields},updated_at:new Date().toISOString()});
        if(error)throw error;
      }
      const {data,error}=await _supabase.from('transactions').update(entryEdit.hash?fields:{...fields,row_hash:entryToken}).eq('id',entryEdit.id).select().single();
      if(error)throw error;saved=data;
    }else{
      // A stable token makes retry after a lost response safe, including on mobile.
      const {data,error}=await _supabase.from('transactions').upsert({...fields,row_hash:entryToken,found_in_statements:null},{onConflict:'row_hash',ignoreDuplicates:true}).select();
      if(error)throw error;saved=data?.[0];
      if(!saved){const {data,error}=await _supabase.from('transactions').select('*').eq('row_hash',entryToken).single();if(error)throw error;saved=data;}
    }
    if(!saved?.id)throw new Error('The server did not confirm the saved transaction. Please retry.');
    const newRow={id:saved.id,hash:saved.row_hash||'',d:saved.date,v:Number(saved.value),s:saved.source||'',b:saved.bank||'',t:saved.type==='Inflow'?'In':saved.type==='Investment'?'Inv':'Out',c:saved.final_category||saved.category||'',r:saved.cost_revenue_type||'',f:saved.found_in_statements||'',edited:true};
    ORIGINAL_TXNS=ORIGINAL_TXNS.filter(t=>String(t.id)!==String(saved.id));ORIGINAL_TXNS.push({...newRow});
    TXNS=ORIGINAL_TXNS.map(t=>({...t}));TXNS.sort((a,b)=>b.d.localeCompare(a.d));applyCategoryRules(TXNS);recomputeAggregates();
    _srcStatsCache={n:-1,map:{}};
    const dates=TXNS.map(t=>t.d).sort();_subMinDate=dates[0]||'';_subMaxDate=dates[dates.length-1]||'';_subCount=TXNS.length;_subUnrecon=TXNS.filter(t=>!t.f).length;
    document.getElementById('yearFilter').innerHTML='<option value="All">All Years</option>'+[...new Set(TXNS.map(t=>t.d.slice(0,4)))].sort().map(y=>`<option value="${y}">${y}</option>`).join('');
    document.getElementById('yearFilter').value=yearFilter;
    entryLock(false);closeQuickAdd();render();
    document.getElementById('entryNotice').textContent=entryText('Saved. You can edit it from Transactions.','Shranjeno. Vnos lahko uredite med transakcijami.');
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
async function scanReceipt(file){
  if(!file||entryBusy)return;
  if(!['image/jpeg','image/png','image/webp'].includes(file.type)||file.size>12*1024*1024){entryStatus(entryText('Choose a JPG, PNG or WebP image under 12 MB. For a PDF, upload a screenshot.','Izberite JPG, PNG ali WebP do 12 MB. Za PDF naložite posnetek zaslona.'),true);return;}
  clearReceipt();const run=receiptRun;entryLock(true);const status=document.getElementById('receiptStatus');
  receiptURL=URL.createObjectURL(file);document.getElementById('receiptPreview').src=receiptURL;document.getElementById('receiptReview').hidden=false;
  document.getElementById('qaDate').value='';document.getElementById('qaAmount').value='';document.getElementById('qaSource').value='';document.getElementById('qaCategory').value='';document.getElementById('qaDetail').value='';setChipState('qaTypeChips','Out');
  status.textContent=entryText('Preparing receipt reader… First scan downloads language files.','Pripravljam bralnik… Prvi pregled prenese jezikovne datoteke.');
  let worker,timer;
  try{
    const task=(async()=>{
      await loadReceiptLibrary();if(run!==receiptRun)return;
      worker=await Tesseract.createWorker(['eng','slv'],1,{workerPath:new URL('vendor/tesseract/worker.min.js',document.baseURI).href,workerBlobURL:false,corePath:'https://cdn.jsdelivr.net/npm/tesseract.js-core@6.0.0',logger:m=>{if(run===receiptRun&&m.status==='recognizing text')status.textContent=entryText('Reading receipt','Berem račun')+`… ${Math.round(m.progress*100)}%`;}});
      if(run!==receiptRun){await worker.terminate();return;}receiptWorker=worker;
      const image=await createImageBitmap(file);const scale=Math.min(1,2400/Math.max(image.width,image.height));
      const canvas=document.createElement('canvas');canvas.width=Math.round(image.width*scale);canvas.height=Math.round(image.height*scale);
      const ctx=canvas.getContext('2d');ctx.fillStyle='#fff';ctx.fillRect(0,0,canvas.width,canvas.height);ctx.drawImage(image,0,0,canvas.width,canvas.height);image.close();
      const result=await worker.recognize(canvas);if(run!==receiptRun)return;
      const parsed=ReceiptParser.parse(result.data.text);
      document.getElementById('receiptText').textContent=result.data.text.slice(0,20000);
      document.getElementById('qaDate').value=parsed.date;document.getElementById('qaAmount').value=parsed.amount??'';document.getElementById('qaSource').value=parsed.merchant;
      const known=TXNS.find(t=>t.s.toLowerCase()===parsed.merchant.toLowerCase()&&t.c);if(known)document.getElementById('qaCategory').value=known.c;
      status.textContent=parsed.currency!=='EUR'?entryText('Non-euro currency detected. Enter the amount in EUR yourself.','Zaznana tuja valuta. Ročno vnesite znesek v EUR.'):entryText('Review all fields against the photo. Uncertain fields are left blank.','Preverite vsa polja s fotografijo. Negotova polja so prazna.');
      checkEntryDuplicates();
    })();
    await Promise.race([task,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error(entryText('Scanning took too long. Try a clearer photo or enter the details manually.','Branje traja predolgo. Poskusite z jasnejšo sliko ali ročnim vnosom.'))),90000);})]);
  }catch(err){if(run===receiptRun){receiptRun++;status.textContent=entryText('Could not read this receipt. You can fill in the fields manually.','Računa ni bilo mogoče prebrati. Polja lahko izpolnite ročno.');entryStatus(err.message,true);}}
  finally{clearTimeout(timer);if(worker)await worker.terminate().catch(()=>{});receiptWorker=null;entryLock(false);}
}
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
