/* Invoice dates, references and item details live in private receipt metadata. */
let invoiceEditingId=null,invoiceEditingVersion=null,invoiceSaving=false;
function invoiceData(receipt){return receipt.extracted||{};}
function invoiceDate(receipt){const p=invoiceData(receipt);return p.invoice_date||p.date||'';}
function invoiceNumberLabel(receipt){return invoiceData(receipt).invoice_number||'Not visible / not entered';}
function invoiceActive(receipt){return receipt.status!=='dismissed'&&(!receipt.transaction_id||!FINANCE_ROWS.find(t=>String(t.id)===String(receipt.transaction_id))?.deleted_at);}
function invoiceRows(query='',mode='invoices'){
 const q=query.trim().toLocaleLowerCase();const result=[];
 for(const receipt of FINANCE_RECEIPTS.filter(invoiceActive).sort((a,b)=>invoiceDate(b).localeCompare(invoiceDate(a)))){
  const p=invoiceData(receipt),base=[p.merchant,invoiceDate(receipt),p.invoice_number,p.reference,receipt.original_name].join(' ').toLocaleLowerCase();
  if(mode==='items')for(const item of p.line_items||[]){if(!q||(base+' '+[item.description,item.sku,item.category].join(' ').toLocaleLowerCase()).includes(q))result.push({receipt,item});}
  else if(!q||(base+' '+(p.line_items||[]).map(i=>i.description).join(' ').toLocaleLowerCase()).includes(q))result.push({receipt});
 }
 return result;
}
function renderInvoices(){
 document.getElementById('content').innerHTML=`<div class="wf-heading"><div><h2>Invoices & items</h2><p>Invoice dates, numbers and purchases from your receipts. Item details do not add a second expense.</p></div><label class="fp-btn fp-btn-primary wf-upload">Upload invoices<input aria-label="Upload invoices" type="file" multiple accept="image/jpeg,image/png,image/webp,application/pdf" onchange="uploadReceiptBatch(this.files)"></label></div><div class="invoice-controls"><label>Search invoices or items<input class="fp-input" id="invoiceSearch" placeholder="Merchant, item, date or invoice number" oninput="renderInvoiceResults()"></label><label>View<select class="fp-select" id="invoiceView" onchange="renderInvoiceResults()"><option value="invoices">Invoices</option><option value="items">Purchased items</option></select></label><button class="page-btn" onclick="exportInvoiceItems()">Export items CSV</button></div><p id="invoiceSummary" class="entry-hint"></p><div id="invoiceResults"></div>`;
 renderInvoiceResults();
}
function renderInvoiceResults(){
 const mode=document.getElementById('invoiceView').value,rows=invoiceRows(document.getElementById('invoiceSearch').value,mode);
 const sum=rows.reduce((s,row)=>s+Math.round(Number(mode==='items'?row.item.total:invoiceData(row.receipt).amount||0)*100),0)/100;
 const unlinked=new Set(rows.filter(r=>!r.receipt.transaction_id).map(r=>r.receipt.id)).size;
 document.getElementById('invoiceSummary').textContent=`${rows.length} ${mode==='items'?'item lines':'invoices'} · €${sum.toFixed(2)} documented · ${unlinked} invoices not yet linked to an expense. Archived invoices and trashed expenses are excluded.`;
 document.getElementById('invoiceResults').innerHTML=rows.length?`<div class="invoice-table-wrap"><table class="invoice-table"><thead><tr><th>Invoice date</th><th>Merchant / invoice</th>${mode==='items'?'<th>Item</th><th>Quantity</th><th>Unit price</th><th>Discount</th>':'<th>Items</th><th>Status</th>'}<th>Total</th><th></th></tr></thead><tbody>${rows.map(({receipt:r,item})=>{const p=invoiceData(r);return `<tr><td>${wfEscape(invoiceDate(r)||'Needs review')}</td><td>${wfEscape(p.merchant||r.original_name)}<small>${wfEscape(invoiceNumberLabel(r))}</small></td>${item?`<td>${wfEscape(item.description)}<small>${wfEscape(item.category||item.sku||'')}</small></td><td>${item.quantity==null?'—':wfEscape(item.quantity)} ${wfEscape(item.unit)}</td><td>${item.unit_price==null?'—':'€'+wfEscape(item.unit_price)}</td><td>${item.discount==null?'—':'€'+Number(item.discount).toFixed(2)}</td>`:`<td>${(p.line_items||[]).length}<small>${InvoiceData.balance(p).matches?'Totals match':'Details need review'}</small></td><td>${r.transaction_id?'Linked':'Needs expense match'}</td>`}<td>€${Number(item?item.total:p.amount||0).toFixed(2)}</td><td><button class="page-btn" data-id="${wfEscape(r.id)}" onclick="openInvoiceDetails(this.dataset.id)">Details</button></td></tr>`;}).join('')}</tbody></table></div>`:'<section class="wf-card"><p>No matching invoice details. Upload a receipt, then add or correct its item lines.</p></section>';
}
function invoiceItemEditor(items){
 document.getElementById('invoiceItemsBody').innerHTML=items.map((item,i)=>`<tr data-invoice-item><td><input class="fp-input" data-field="description" aria-label="Item ${i+1} description" maxlength="500" value="${wfEscape(item.description)}"><input class="fp-input" data-field="sku" aria-label="Item ${i+1} product code" placeholder="Product code (optional)" maxlength="100" value="${wfEscape(item.sku)}"><input class="fp-input" data-field="category" aria-label="Item ${i+1} category" placeholder="Category (optional)" maxlength="100" value="${wfEscape(item.category)}"></td><td><input class="fp-input" data-field="quantity" aria-label="Item ${i+1} quantity" type="number" min="0.001" step="any" value="${wfEscape(item.quantity)}"><input class="fp-input" data-field="unit" aria-label="Item ${i+1} unit" placeholder="pcs, kg, L" maxlength="30" value="${wfEscape(item.unit)}"></td><td><input class="fp-input" data-field="unit_price" aria-label="Item ${i+1} unit price" type="number" min="0" step="any" value="${wfEscape(item.unit_price)}"></td><td><input class="fp-input" data-field="discount" aria-label="Item ${i+1} discount" type="number" min="0" step="0.01" value="${wfEscape(item.discount)}"></td><td><input class="fp-input" data-field="total" aria-label="Item ${i+1} total" type="number" step="0.01" value="${wfEscape(item.total)}"></td><td><button class="page-btn" type="button" data-index="${i}" onclick="removeInvoiceItem(Number(this.dataset.index))">Remove</button></td></tr>`).join('');
 updateInvoiceBalance();
}
function invoiceDraftItems(){return [...document.querySelectorAll('[data-invoice-item]')].map(row=>Object.fromEntries([...row.querySelectorAll('[data-field]')].map(input=>[input.dataset.field,input.value])));}
function addInvoiceItem(){invoiceItemEditor([...invoiceDraftItems(),{description:'',quantity:1,unit:'pcs',unit_price:null,discount:0,total:null}]);}
function removeInvoiceItem(index){invoiceItemEditor(invoiceDraftItems().filter((_,i)=>i!==index));}
function invoiceDraft(){return {merchant:document.getElementById('invoiceMerchant').value,invoice_date:document.getElementById('invoiceDate').value,invoice_number:document.getElementById('invoiceNumber').value,invoice_number_note:document.getElementById('invoiceNumberNote').value,reference:document.getElementById('invoiceReference').value,amount:document.getElementById('invoiceAmount').value,currency:document.getElementById('invoiceCurrency').value,notes:document.getElementById('invoiceNotes').value,line_items:invoiceDraftItems()};}
function updateInvoiceBalance(){const p=invoiceDraft();const b=InvoiceData.balance(p);document.getElementById('invoiceBalance').textContent=b.matches?`Items add up to €${b.sum.toFixed(2)} — matches the invoice.`:`Items: €${b.sum.toFixed(2)} · Invoice: ${p.amount===''?'not entered':'€'+Number(p.amount).toFixed(2)}${b.difference===null?'':` · Difference: €${b.difference.toFixed(2)}`}. Incomplete details can be saved for later review.`;}
function openInvoiceDetails(id){
 if(invoiceSaving)return;const r=FINANCE_RECEIPTS.find(r=>r.id===id);if(!r)return;
 invoiceEditingId=id;invoiceEditingVersion=r.updated_at;const p=invoiceData(r);
 for(const [id,value]of Object.entries({invoiceMerchant:p.merchant||'',invoiceDate:invoiceDate(r),invoiceNumber:p.invoice_number||'',invoiceNumberNote:p.invoice_number_note||'',invoiceReference:p.reference||'',invoiceAmount:p.amount??'',invoiceCurrency:p.currency||'EUR',invoiceNotes:p.notes||''}))document.getElementById(id).value=value;
 invoiceItemEditor(p.line_items||[]);document.getElementById('invoiceSaveStatus').textContent='';
 document.getElementById('invoiceLinkedStatus').textContent=r.transaction_id?`Linked to transaction ${r.transaction_id}. Editing invoice details keeps the bank transaction unchanged.`:'This invoice has not been linked to an expense yet.';
 document.getElementById('invoiceRecordExpense').textContent=r.transaction_id?'Edit linked expense':'Match or record expense';
 const dialog=document.getElementById('invoiceDialog');if(!dialog.open)dialog.showModal();
}
function closeInvoiceDetails(){if(invoiceSaving)return;document.getElementById('invoiceDialog').close();invoiceEditingId=null;}
async function saveInvoiceDetails(event){
 event?.preventDefault();if(invoiceSaving||!financeSession||!invoiceEditingId)return;
 const status=document.getElementById('invoiceSaveStatus');let clean;
 try{clean=InvoiceData.clean(invoiceDraft());}catch(error){status.textContent=error.message;return;}
 const r=FINANCE_RECEIPTS.find(r=>r.id===invoiceEditingId);if(!r)return;
 const duplicate=InvoiceData.identity(clean)&&FINANCE_RECEIPTS.find(other=>other.id!==r.id&&InvoiceData.identity(invoiceData(other))===InvoiceData.identity(clean));
 if(duplicate){status.textContent='Another receipt already has this merchant, invoice number and date. Check it before saving.';return;}
 invoiceSaving=true;document.getElementById('invoiceSave').disabled=true;status.textContent='Saving invoice details…';
 try{
  const updated_at=new Date().toISOString(),extracted={...r.extracted,...clean,reviewed_at:updated_at,items_complete:InvoiceData.balance(clean).matches};
  const {data,error}=await _supabase.from('finance_receipts').update({extracted,updated_at}).eq('id',r.id).eq('updated_at',invoiceEditingVersion).select('id');
  if(error)throw error;if(!data?.length)throw new Error('This invoice changed elsewhere. Close and reopen it before saving.');
  r.extracted=extracted;r.updated_at=updated_at;invoiceEditingVersion=updated_at;
  status.textContent=extracted.items_complete?'Invoice and items saved. Item totals match.':'Invoice saved with incomplete item details; check the totals when ready.';
  if(activeTab==='invoices')renderInvoices();
 }catch(error){status.textContent=error.message||'Could not save invoice details.';}
 finally{invoiceSaving=false;document.getElementById('invoiceSave').disabled=false;}
}
function invoiceGoToExpense(){const r=FINANCE_RECEIPTS.find(r=>r.id===invoiceEditingId);if(!r)return;closeInvoiceDetails();if(r.transaction_id)openQuickAdd(r.transaction_id);else openStoredReceipt(r.id);}
function exportInvoiceItems(){
 const rows=invoiceRows(document.getElementById('invoiceSearch')?.value||'','items');
 const cell=v=>'"'+String(v??'').replace(/^[=+@-]/,"'$&").replaceAll('"','""')+'"';
 const header=['Invoice date','Invoice number','Merchant','Item','Product code','Quantity','Unit','Unit price EUR','Discount EUR','Line total EUR','Category','Transaction ID'];
 const csv='\uFEFF'+[header,...rows.map(({receipt:r,item:i})=>[invoiceDate(r),invoiceData(r).invoice_number,invoiceData(r).merchant,i.description,i.sku,i.quantity,i.unit,i.unit_price,i.discount,i.total,i.category,r.transaction_id])].map(r=>r.map(cell).join(',')).join('\r\n');
 downloadPrivateBlob(new Blob([csv],{type:'text/csv;charset=utf-8'}),'invoice-items.csv');
}
function clearInvoiceState(){invoiceEditingId=null;invoiceEditingVersion=null;document.getElementById('invoiceForm')?.reset();document.getElementById('invoiceItemsBody')?.replaceChildren();const dialog=document.getElementById('invoiceDialog');if(dialog?.open)dialog.close();}
