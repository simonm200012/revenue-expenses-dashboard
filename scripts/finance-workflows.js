/* Private receipt review, reversible changes and downloadable snapshots. */
let FINANCE_ROWS=[],FINANCE_RECEIPTS=[],FINANCE_BACKUPS=[],activeReceiptId=null,receiptBatchBusy=false,workflowEpoch=0;
let receiptPdfPromise,privatePreviewURLs=new Set(),lastUndo=null,backupBusy=false;
const receiptTypes=['image/jpeg','image/png','image/webp','application/pdf'];
const wfEscape=value=>escapeHtml(String(value??''));
function workflowNotice(message,error=false){const n=document.getElementById('entryNotice');n.textContent=message;n.style.color=error?'var(--acc-red)':'var(--text3)';}
async function financePageAll(table,order='id'){
 const result=[];
 for(let offset=0;;offset+=1000){const {data,error}=await _supabase.from(table).select('*').order(order).range(offset,offset+999);if(error)throw error;result.push(...data);if(data.length<1000)return result;}
}
async function refreshPrivateWorkflows(){
 const epoch=workflowEpoch;
 const [receipts,backups]=await Promise.all([financePageAll('finance_receipts'),financePageAll('finance_backups','created_at')]);
 if(epoch!==workflowEpoch)return;
 FINANCE_RECEIPTS=receipts;FINANCE_BACKUPS=backups.sort((a,b)=>b.created_at.localeCompare(a.created_at));
}
function financeRow(row){return {id:row.id,hash:row.row_hash||'',updated_at:row.updated_at,edited:!!row._edited||String(row.row_hash||'').startsWith('app:'),d:row.date||'',v:Number(row.value)||0,s:row.source||'',b:row.bank||'',t:row.type==='Inflow'?'In':row.type==='Investment'?'Inv':'Out',c:row.final_category||row.category||'',r:row.cost_revenue_type||'',f:row.found_in_statements||''};}
function acceptSavedTransaction(row){
 FINANCE_ROWS=FINANCE_ROWS.filter(t=>String(t.id)!==String(row.id));FINANCE_ROWS.push(row);
 if(row.row_hash&&!row.row_hash.startsWith('app:'))importedEdits.set(row.row_hash,cleanTransactionFields({...row,value:Number(row.value)}));
 ORIGINAL_TXNS=FINANCE_ROWS.filter(t=>!t.deleted_at).map(effectiveTransaction).map(financeRow).filter(t=>t.d);
 TXNS=ORIGINAL_TXNS.map(t=>({...t})).sort((a,b)=>b.d.localeCompare(a.d));applyCategoryRules(TXNS);recomputeAggregates();_srcStatsCache={n:-1,map:{}};
 localStorage.removeItem('dash-ai-cache-v1');localStorage.removeItem('plan-narrative-cache');
 const dates=TXNS.map(t=>t.d).sort();_subMinDate=dates[0]||'';_subMaxDate=dates.at(-1)||'';_subCount=TXNS.length;_subUnrecon=TXNS.filter(t=>!t.f).length;
 document.getElementById('yearFilter').innerHTML='<option value="All">All Years</option>'+[...new Set(TXNS.map(t=>t.d.slice(0,4)))].sort().map(y=>`<option value="${wfEscape(y)}">${wfEscape(y)}</option>`).join('');
 document.getElementById('yearFilter').value=yearFilter;
}
function offerUndo(result,message){
 lastUndo=result.history_id?{id:result.history_id,expected:result.transaction.updated_at}:null;
 const n=document.getElementById('entryNotice');n.textContent=message+' ';
 if(lastUndo){const button=document.createElement('button');button.className='page-btn';button.textContent='Undo';button.onclick=undoLatestFinanceChange;n.append(button);}
}
async function undoLatestFinanceChange(){
 if(!lastUndo)return;const undo=lastUndo;lastUndo=null;
 try{const {data,error}=await _supabase.rpc('finance_restore_history',{p_history:undo.id,p_expected:undo.expected});if(error)throw error;acceptSavedTransaction(data);render();workflowNotice('Change undone.');}catch(error){workflowNotice(error.message,true);}
}
async function setTransactionDeleted(id,deleted){
 const row=FINANCE_ROWS.find(t=>String(t.id)===String(id));if(!row)return;
 try{const {data,error}=await _supabase.rpc('finance_set_deleted',{p_id:row.id,p_deleted:deleted,p_expected:row.updated_at});if(error)throw error;acceptSavedTransaction(data.transaction);entryBusy=false;closeQuickAdd();render();offerUndo(data,deleted?'Moved to Trash.':'Transaction restored.');}catch(error){entryStatus(error.message,true);workflowNotice(error.message,true);}
}
function wfTransaction(row){return `<div class="wf-row"><div><strong>${wfEscape(row.s??row.source)}</strong><small>${wfEscape(row.d??row.date)} · ${wfEscape(row.b??row.bank)} · ${wfEscape(row.c??row.final_category??row.category)}</small></div><strong>€${Number(row.v??row.value).toFixed(2)}</strong><button class="page-btn" data-id="${wfEscape(row.id)}" onclick="openQuickAdd(this.dataset.id)">Review</button></div>`;}
function possibleDuplicateGroups(rows){const groups=new Map();for(const t of rows){const key=[t.d,Math.round(t.v*100),t.t].join('|');if(!groups.has(key))groups.set(key,[]);groups.get(key).push(t);}return [...groups.values()].filter(g=>g.length>1).sort((a,b)=>b[0].d.localeCompare(a[0].d));}
function receiptMatches(receipt,rows=TXNS){
 const p=receipt.extracted||{};if(p.amount==null||!p.date)return [];
 return rows.filter(t=>t.t==='Out'&&Math.abs(t.v-p.amount)<0.011&&Math.abs(Date.parse(t.d)-Date.parse(p.date))<=3*86400000).sort((a,b)=>Math.abs(Date.parse(a.d)-Date.parse(p.date))-Math.abs(Date.parse(b.d)-Date.parse(p.date)));
}
function receiptQueueCard(r){const p=r.extracted||{};return `<div class="wf-row"><div><strong>${wfEscape(p.merchant||r.original_name)}</strong><small>${wfEscape(r.original_name)}${r.mime_type==='application/pdf'?' · Page '+r.page_number:''} · ${wfEscape(p.date||'Date needs review')} · ${r.status==='linked'?'Attached to transaction':r.status==='dismissed'?'Archived':'Needs review'}</small></div><strong>${p.amount==null?'Check total':'€'+Number(p.amount).toFixed(2)}</strong><button class="page-btn" data-id="${wfEscape(r.id)}" onclick="openStoredReceipt(this.dataset.id)">${r.status==='linked'?'View':'Review'}</button>${r.status==='pending'?`<button class="page-btn" data-id="${wfEscape(r.id)}" onclick="archiveReceipt(this.dataset.id,true)">Archive</button>`:''}${r.status==='dismissed'?`<button class="page-btn" data-id="${wfEscape(r.id)}" onclick="archiveReceipt(this.dataset.id,false)">Reopen</button>`:''}</div>`;}
function renderReview(){
 const pending=FINANCE_RECEIPTS.filter(r=>r.status==='pending'),uncat=TXNS.filter(t=>t.t==='Out'&&(!t.c||/^(uncategorized|other|unknown|nerazvrščeno)$/i.test(t.c))),groups=possibleDuplicateGroups(TXNS);
 document.getElementById('content').innerHTML=`<div class="wf-heading"><div><h2>Review inbox</h2><p>Finish receipts, check categories and review possible duplicates. All dates are included.</p></div><label class="fp-btn fp-btn-primary wf-upload">Upload receipts<input type="file" multiple accept="image/jpeg,image/png,image/webp,application/pdf" onchange="uploadReceiptBatch(this.files)"></label></div><p id="receiptBatchStatus" role="status" aria-live="polite">${receiptBatchBusy?'Reading your uploads…':''}</p><div class="wf-grid"><section class="wf-card"><h3>Receipts · ${pending.length}</h3><p>Images and PDFs, up to 20 MB each and 50 pages per PDF. Confirm each purchase before recording it.</p>${pending.length?pending.map(receiptQueueCard).join(''):'<p class="wf-empty">No receipts waiting for review.</p>'}</section><section class="wf-card"><h3>Categories to check · ${uncat.length}</h3>${uncat.length?uncat.slice(0,100).map(wfTransaction).join(''):'<p class="wf-empty">Every expense has a category.</p>'}${uncat.length>100?'<p>Showing the first 100. More will appear as you review them.</p>':''}</section></div><section class="wf-card"><h3>Possible duplicates · ${groups.length} groups</h3><p>Same date, amount and type. These may be separate purchases; review before moving anything to Trash.</p>${groups.slice(0,50).map(g=>`<div class="wf-duplicate">${g.map(wfTransaction).join('')}</div>`).join('')||'<p class="wf-empty">No possible duplicates found.</p>'}${groups.length>50?'<p>Showing the first 50 groups.</p>':''}</section><details class="wf-card"><summary>Attached and archived receipts · ${FINANCE_RECEIPTS.length-pending.length}</summary>${FINANCE_RECEIPTS.filter(r=>r.status!=='pending').map(receiptQueueCard).join('')}</details>`;
}
function renderTrash(){const rows=FINANCE_ROWS.filter(t=>t.deleted_at).sort((a,b)=>b.deleted_at.localeCompare(a.deleted_at));document.getElementById('content').innerHTML=`<div class="wf-heading"><div><h2>Trash</h2><p>These entries are excluded from totals. Restore them at any time; daily Sheets imports keep them here.</p></div></div><section class="wf-card">${rows.length?rows.map(r=>`<div class="wf-row"><div><strong>${wfEscape(r.source)}</strong><small>${wfEscape(r.date)} · ${wfEscape(r.bank)} · Removed ${wfEscape(new Date(r.deleted_at).toLocaleDateString())}</small></div><strong>€${Number(r.value).toFixed(2)}</strong><button class="page-btn" data-id="${wfEscape(r.id)}" onclick="setTransactionDeleted(this.dataset.id,false)">Restore</button><button class="page-btn" data-id="${wfEscape(r.id)}" onclick="showTransactionHistory(this.dataset.id)">History</button></div>`).join(''):'<p class="wf-empty">Trash is empty.</p>'}</section><section id="trashHistory"></section>`;}
async function showTransactionHistory(id){
 const target=document.getElementById('quickAddPanel').classList.contains('open')?document.getElementById('qaHistory'):document.getElementById('trashHistory');if(!target)return;target.hidden=false;target.textContent='Loading history…';
 const {data,error}=await _supabase.from('finance_history').select('*').eq('transaction_id',id).order('id',{ascending:false}).limit(100);
 if(error){target.textContent=error.message;return;}
 target.innerHTML='<h3>Change history</h3><p>History begins when private access was enabled. The latest 100 changes are shown.</p>'+data.map(h=>{const before=h.old_record,after=h.new_record;const changes=['date','value','source','bank','type','final_category','cost_revenue_type','deleted_at'].filter(k=>before?.[k]!==after?.[k]).map(k=>`${wfEscape(k.replaceAll('_',' '))}: ${wfEscape(before?.[k]??'—')} → ${wfEscape(after?.[k]??'—')}`).join('<br>');return `<div class="wf-history"><strong>${wfEscape(h.action)} · ${wfEscape(h.actor)}</strong><small>${wfEscape(new Date(h.created_at).toLocaleString())}</small><p>${changes}</p><button class="page-btn" data-id="${wfEscape(h.id)}" data-tx="${wfEscape(id)}" onclick="restoreHistoryVersion(this.dataset.id,this.dataset.tx)">${before?'Restore before this change':'Undo creation'}</button></div>`;}).join('');
}
async function restoreHistoryVersion(id,transaction){
 const row=FINANCE_ROWS.find(t=>String(t.id)===String(transaction));if(!row||!confirm('Restore the entry to before this change? Your current version will remain in its history.'))return;
 try{const {data,error}=await _supabase.rpc('finance_restore_history',{p_history:Number(id),p_expected:row.updated_at});if(error)throw error;acceptSavedTransaction(data);closeQuickAdd();render();workflowNotice('Previous version restored.');}catch(error){workflowNotice(error.message,true);entryStatus(error.message,true);}
}
function disposePrivateReceipts(){workflowEpoch++;activeReceiptId=null;FINANCE_RECEIPTS=[];FINANCE_BACKUPS=[];FINANCE_ROWS=[];for(const url of privatePreviewURLs)URL.revokeObjectURL(url);privatePreviewURLs.clear();document.getElementById('privateReceiptDialog')?.close();}
async function receiptDigest(buffer){return [...new Uint8Array(await crypto.subtle.digest('SHA-256',buffer))].map(v=>v.toString(16).padStart(2,'0')).join('');}
function loadReceiptPdf(){if(!receiptPdfPromise)receiptPdfPromise=import(new URL('vendor/pdfjs/pdf.min.mjs',document.baseURI).href).then(pdf=>{pdf.GlobalWorkerOptions.workerSrc=new URL('vendor/pdfjs/pdf.worker.min.mjs',document.baseURI).href;return pdf;}).catch(e=>{receiptPdfPromise=null;throw e;});return receiptPdfPromise;}
async function receiptPdfDocument(buffer){const pdf=await loadReceiptPdf();return pdf.getDocument({data:new Uint8Array(buffer),isEvalSupported:false,disableFontFace:true,useSystemFonts:true,cMapUrl:new URL('vendor/pdfjs/cmaps/',document.baseURI).href,cMapPacked:true,standardFontDataUrl:new URL('vendor/pdfjs/standard_fonts/',document.baseURI).href,wasmUrl:new URL('vendor/pdfjs/wasm/',document.baseURI).href}).promise;}
async function receiptPageCanvas(page){const view=page.getViewport({scale:1}),scale=Math.min(2.4,2400/Math.max(view.width,view.height)),viewport=page.getViewport({scale});const canvas=document.createElement('canvas');canvas.width=Math.ceil(viewport.width);canvas.height=Math.ceil(viewport.height);await page.render({canvasContext:canvas.getContext('2d'),viewport}).promise;return canvas;}
function pdfReceiptText(items){let lines=[],lastY=null,line=[];for(const item of items){if(typeof item.str!=='string')continue;const y=Math.round(item.transform[5]);if(lastY!==null&&Math.abs(y-lastY)>3&&line.length){lines.push(line.join(' '));line=[];}line.push(item.str);lastY=y;if(item.hasEOL){lines.push(line.join(' '));line=[];lastY=null;}}if(line.length)lines.push(line.join(' '));return lines.join('\n');}
async function recognizeReceiptImage(source,onProgress){
 await loadReceiptLibrary();let worker,timer;
 try{worker=await Tesseract.createWorker(['eng','slv'],1,{workerPath:new URL('vendor/tesseract/worker.min.js',document.baseURI).href,workerBlobURL:false,corePath:'https://cdn.jsdelivr.net/npm/tesseract.js-core@6.0.0',logger:m=>{if(m.status==='recognizing text')onProgress?.(Math.round(m.progress*100));}});
 let canvas=source;if(source instanceof Blob){const bitmap=await createImageBitmap(source),scale=Math.min(1,2400/Math.max(bitmap.width,bitmap.height));canvas=document.createElement('canvas');canvas.width=Math.max(1,Math.round(bitmap.width*scale));canvas.height=Math.max(1,Math.round(bitmap.height*scale));const ctx=canvas.getContext('2d');ctx.fillStyle='#fff';ctx.fillRect(0,0,canvas.width,canvas.height);ctx.drawImage(bitmap,0,0,canvas.width,canvas.height);bitmap.close();}
 const result=await Promise.race([worker.recognize(canvas),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Reading timed out. Open this receipt to enter the details manually.')),90000);})]);return result.data.text.slice(0,30000);
 }finally{clearTimeout(timer);if(worker)await worker.terminate().catch(()=>{});}
}
function batchStatus(text){const node=document.getElementById('receiptBatchStatus');if(node)node.textContent=text;document.getElementById('receiptStatus').textContent=text;}
async function uploadReceiptBatch(fileList){
 if(receiptBatchBusy||!financeSession)return;
 const files=[...fileList];if(!files.length)return;if(files.length>20){workflowNotice('Choose up to 20 files at once.',true);return;}
 receiptBatchBusy=true;const epoch=workflowEpoch;let added=0,skipped=0;const errors=[];
 try{for(let i=0;i<files.length;i++){
  if(epoch!==workflowEpoch)break;const file=files[i];let pdf;
  try{
   if(!receiptTypes.includes(file.type)||file.size>20*1024*1024||file.size===0)throw new Error('Choose a JPG, PNG, WebP or PDF up to 20 MB.');
   batchStatus(`Uploading ${i+1}/${files.length}: ${file.name}`);
   const buffer=await file.arrayBuffer(),hash=await receiptDigest(buffer),ext={'image/jpeg':'jpg','image/png':'png','image/webp':'webp','application/pdf':'pdf'}[file.type];
   if(file.type==='application/pdf'){pdf=await receiptPdfDocument(buffer);if(pdf.numPages>50)throw new Error('PDFs can contain up to 50 pages. Split this file and retry.');}
   const path=financeSession.user.id+'/'+hash+'.'+ext;
   // A hash path makes retries safe; only treat a true existing-object response as success.
   const upload=await _supabase.storage.from('finance-receipts').upload(path,file,{contentType:file.type,cacheControl:'0',upsert:false});
   if(upload.error&&!['409','Duplicate'].includes(String(upload.error.statusCode||upload.error.code)))throw upload.error;
   const pages=Array.from({length:pdf?.numPages||1},(_,i)=>({storage_path:path,original_name:file.name.slice(0,500),mime_type:file.type,file_hash:hash,page_number:i+1,extracted:{read_error:'Reading has not finished. You can enter the details manually.'}}));
   const {data:queued,error:queueError}=await _supabase.from('finance_receipts').upsert(pages,{onConflict:'file_hash,page_number',ignoreDuplicates:true}).select();
   if(queueError)throw queueError;
   added+=queued.length;skipped+=pages.length-queued.length;
   // Persist every page before OCR starts, so leaving the app never loses the inbox item.
   for(const receipt of queued.sort((a,b)=>a.page_number-b.page_number)){
    if(epoch!==workflowEpoch)break;const pageNumber=receipt.page_number;
    batchStatus(`Reading ${file.name}${pdf?' · page '+pageNumber+'/'+pdf.numPages:''}…`);let text='',readErrorText='';
    try{if(pdf){const page=await pdf.getPage(pageNumber);text=pdfReceiptText((await page.getTextContent()).items);if(text.trim().length<40||ReceiptParser.parse(text).amount==null)text=await recognizeReceiptImage(await receiptPageCanvas(page));page.cleanup();}else text=await recognizeReceiptImage(file,p=>batchStatus(`Reading ${file.name}… ${p}%`));}catch(e){readErrorText=e.message;}
    if(epoch!==workflowEpoch)break;
    const extracted={...ReceiptParser.parse(text),text,read_error:readErrorText};
    const {error}=await _supabase.from('finance_receipts').update({extracted,updated_at:new Date().toISOString()}).eq('id',receipt.id);
    if(error)throw error;
   }
  }catch(error){errors.push(file.name+': '+error.message);}finally{if(pdf)await pdf.destroy().catch(()=>{});}
 }
 if(epoch===workflowEpoch){await refreshPrivateWorkflows();if(document.getElementById('quickAddPanel').classList.contains('open'))closeQuickAdd();activeTab='review';render();const message=`${added} receipt page${added===1?'':'s'} ready for review.${skipped?' '+skipped+' already uploaded.':''}${errors.length?' '+errors.join(' '):''}`;batchStatus(message);workflowNotice(message,!!errors.length);}
 }catch(error){workflowNotice('Upload stopped: '+error.message,true);}finally{receiptBatchBusy=false;}
}
async function receiptPreviewBlob(receipt){const {data,error}=await _supabase.storage.from('finance-receipts').download(receipt.storage_path);if(error)throw error;if(receipt.mime_type!=='application/pdf')return data;const pdf=await receiptPdfDocument(await data.arrayBuffer());try{const canvas=await receiptPageCanvas(await pdf.getPage(receipt.page_number));return await new Promise(resolve=>canvas.toBlob(resolve,'image/png'));}finally{await pdf.destroy();}}
async function openStoredReceipt(id){
 const r=FINANCE_RECEIPTS.find(r=>r.id===id);if(!r)return;
 if(r.status==='linked'){await viewPrivateReceipt(id);return;}
 openQuickAdd();activeReceiptId=id;document.getElementById('receiptReview').hidden=false;
 const p=r.extracted||{};document.getElementById('qaDate').value=p.date||'';document.getElementById('qaAmount').value=p.amount??'';document.getElementById('qaSource').value=p.merchant||'';
 const known=TXNS.find(t=>t.s.toLowerCase()===String(p.merchant).toLowerCase()&&t.c);document.getElementById('qaCategory').value=known?.c||'';
 document.getElementById('receiptText').textContent=p.text||'';document.getElementById('receiptStatus').textContent=p.read_error||'Check the date, merchant and total. You can attach this receipt to a matching transaction below.';
 const matches=receiptMatches(r);document.getElementById('qaReceiptMatches').innerHTML='<h3>Attach to an existing transaction</h3><p>Attaching keeps the recorded amount unchanged.</p>'+matches.slice(0,12).map(t=>`<div class="wf-row"><div>${wfEscape(t.s)}<small>${wfEscape(t.d)} · ${wfEscape(t.b)} · €${t.v.toFixed(2)}</small></div><button class="page-btn" data-id="${wfEscape(t.id)}" onclick="attachActiveReceipt(this.dataset.id)">Attach</button></div>`).join('')+(!matches.length?'<p>No same-amount expense found within three days.</p>':'')+'<label for="receiptMatchSearch">Find a different transaction</label><input id="receiptMatchSearch" class="fp-input" placeholder="Merchant, date or amount" oninput="searchReceiptMatches(this.value)"><div id="receiptMatchResults"></div>';
 try{const blob=await receiptPreviewBlob(r);if(activeReceiptId!==id)return;receiptURL=URL.createObjectURL(blob);document.getElementById('receiptPreview').src=receiptURL;}catch(error){entryStatus('Preview unavailable: '+error.message,true);}
}
function searchReceiptMatches(query){const q=query.trim().toLowerCase();const rows=q.length<2?[]:TXNS.filter(t=>t.t==='Out'&&[t.s,t.d,t.b,t.v.toFixed(2)].some(v=>String(v).toLowerCase().includes(q))).slice(0,12);document.getElementById('receiptMatchResults').innerHTML=rows.map(t=>`<div class="wf-row"><div>${wfEscape(t.s)}<small>${wfEscape(t.d)} · ${wfEscape(t.b)} · €${t.v.toFixed(2)}</small></div><button class="page-btn" data-id="${wfEscape(t.id)}" onclick="attachActiveReceipt(this.dataset.id)">Attach</button></div>`).join('');}
async function attachActiveReceipt(id){if(!activeReceiptId||entryBusy)return;if(!document.getElementById('receiptConfirmed').checked){entryStatus('Confirm that you checked the receipt first.',true);return;}entryLock(true);try{const {error}=await _supabase.rpc('finance_link_receipt',{p_receipt:activeReceiptId,p_transaction:Number(id)});if(error)throw error;await refreshPrivateWorkflows();entryLock(false);closeQuickAdd();render();workflowNotice('Receipt attached. Spending totals are unchanged.');}catch(error){entryLock(false);entryStatus(error.message,true);}}
async function archiveReceipt(id,archive){try{const {error}=await _supabase.from('finance_receipts').update({status:archive?'dismissed':'pending',updated_at:new Date().toISOString()}).eq('id',id).is('transaction_id',null);if(error)throw error;await refreshPrivateWorkflows();render();}catch(error){workflowNotice(error.message,true);}}
async function viewPrivateReceipt(id){const receipt=FINANCE_RECEIPTS.find(r=>r.id===id);if(!receipt)return;const dialog=document.getElementById('privateReceiptDialog');document.getElementById('privateReceiptTitle').textContent=receipt.original_name+(receipt.mime_type==='application/pdf'?' · page '+receipt.page_number:'');const content=document.getElementById('privateReceiptContent');content.textContent='Loading private receipt…';dialog.showModal();const epoch=workflowEpoch;try{const blob=await receiptPreviewBlob(receipt);if(epoch!==workflowEpoch)return;const url=URL.createObjectURL(blob);privatePreviewURLs.add(url);const img=document.createElement('img');img.src=url;img.alt='Receipt';content.replaceChildren(img);const button=document.createElement('button');button.className='page-btn';button.textContent='Download original';button.onclick=()=>downloadReceiptOriginal(receipt);content.append(button);}catch(error){content.textContent=error.message;}}
function downloadPrivateBlob(blob,name){const url=URL.createObjectURL(blob);privatePreviewURLs.add(url);const a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>{URL.revokeObjectURL(url);privatePreviewURLs.delete(url);},30000);}
async function downloadReceiptOriginal(receipt){const {data,error}=await _supabase.storage.from('finance-receipts').download(receipt.storage_path);if(error){workflowNotice(error.message,true);return;}downloadPrivateBlob(data,receipt.original_name);}
function renderBackups(){document.getElementById('content').innerHTML=`<div class="wf-heading"><div><h2>Private backups</h2><p>Daily snapshots of transactions, Trash, settings, receipt metadata and change history. Original receipts stay in private receipt storage.</p></div><button id="createBackupButton" class="fp-btn fp-btn-primary" onclick="createPrivateBackup()" ${backupBusy?'disabled':''}>${backupBusy?'Creating backup…':'Back up now'}</button></div><section class="wf-card"><p>Automatic backup runs daily, 05:00–06:00 Ljubljana, before the Sheets import. Snapshots are kept until you choose otherwise. Downloads contain private financial data.</p>${FINANCE_BACKUPS.length?FINANCE_BACKUPS.map(b=>`<div class="wf-row"><div><strong>${wfEscape(new Date(b.created_at).toLocaleString())}</strong><small>${wfEscape(b.source)} · ${b.row_count} transactions · ${(b.byte_count/1024).toFixed(1)} KB</small></div><button class="page-btn" data-id="${wfEscape(b.id)}" onclick="downloadFinanceBackup(this.dataset.id)">Download JSON</button></div>`).join(''):'<p class="wf-empty">No backup has completed yet.</p>'}</section>`;}
async function createPrivateBackup(){if(backupBusy)return;backupBusy=true;if(activeTab==='backups')renderBackups();try{const {data:payload,error:snapshotError}=await _supabase.rpc('finance_export_snapshot');if(snapshotError)throw snapshotError;if(!payload?.transactions)throw new Error('Private access is required.');const raw=new TextEncoder().encode(JSON.stringify(payload)),compressed=await new Response(new Blob([raw]).stream().pipeThrough(new CompressionStream('gzip'))).blob();const path='manual/'+crypto.randomUUID()+'.json.gz',sha256=await receiptDigest(await compressed.arrayBuffer());const {error}=await _supabase.storage.from('finance-backups').upload(path,compressed,{contentType:'application/gzip',cacheControl:'0',upsert:false});if(error)throw error;const result=await _supabase.from('finance_backups').insert({storage_path:path,created_at:payload.created_at,row_count:payload.transactions.length,byte_count:compressed.size,sha256,source:'Manual'});if(result.error)throw result.error;await refreshPrivateWorkflows();workflowNotice('Private backup saved.');}catch(error){workflowNotice('Backup failed: '+error.message,true);}finally{backupBusy=false;if(activeTab==='backups')renderBackups();}}
async function downloadFinanceBackup(id){const b=FINANCE_BACKUPS.find(b=>b.id===id);if(!b)return;try{const {data,error}=await _supabase.storage.from('finance-backups').download(b.storage_path);if(error)throw error;if(await receiptDigest(await data.arrayBuffer())!==b.sha256)throw new Error('Backup checksum does not match. The download was stopped.');const json=await new Response(data.stream().pipeThrough(new DecompressionStream('gzip'))).blob();downloadPrivateBlob(json,'finance-backup-'+b.created_at.slice(0,10)+'.json');}catch(error){workflowNotice(error.message,true);}}
