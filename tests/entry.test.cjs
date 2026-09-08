const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const {JSDOM}=require('jsdom');
const html=fs.readFileSync('index.html','utf8');
function app(){
 const dom=new JSDOM(html,{url:'https://example.test/',runScripts:'outside-only'}),w=dom.window;
 const writes=[],rows=[],receipts=[],state=new Map();let failSave=false;
 const client={storage:{from(){return {upload:async()=>({error:null})};}},rpc:async(name,p)=>{
 if(name==='finance_is_owner')return {data:true};
 if(name!=='finance_save_entry')return {data:null,error:{message:'Unexpected RPC'}};
 writes.push({table:'transactions',op:'rpc',payload:{...p.p_fields,row_hash:p.p_token}});
 if(failSave){failSave=false;return{error:{message:'Connection lost'}};}
 let row=p.p_id?rows.find(r=>String(r.id)===String(p.p_id)):rows.find(r=>r.row_hash===p.p_token);
 if(!row){row={id:rows.length+1,row_hash:p.p_token};rows.push(row);}
 Object.assign(row,p.p_fields,{updated_at:new Date().toISOString(),deleted_at:null});
 if(p.p_id&&row.row_hash&&!row.row_hash.startsWith('app:'))state.set('txn-edit:'+row.row_hash,{fields:p.p_fields});
 return{data:{transaction:{...row},history_id:1}};
 },from(table){let op='read',payload,filters={},ignore=false;const q={select(){return q;},order(){return q;},range(){return q;},like(){return q;},in(){return q;},is(k,v){filters[k]=v;return q;},limit(){return q;},eq(k,v){filters[k]=v;return q;},maybeSingle(){return q;},single(){q.isSingle=true;return q;},insert(v){op='insert';payload=v;return q;},upsert(v,options){op='upsert';payload=v;ignore=options?.ignoreDuplicates;return q;},update(v){op='update';payload=v;return q;},then(resolve,reject){return Promise.resolve().then(()=>{
 if(op!=='read')writes.push({table,op,payload});
 if(op!=='read'&&table==='transactions'&&failSave){failSave=false;return{data:null,error:{message:'Connection lost'}};}
 if(table==='finance_backups')return{data:[],error:null};
 if(table==='finance_receipts'){
 if(op==='upsert'){const added=[];for(const item of payload){if(receipts.some(r=>r.file_hash===item.file_hash&&r.page_number===item.page_number))continue;const row={id:'receipt-'+(receipts.length+1),status:'pending',...item};receipts.push(row);added.push(row);}return{data:added,error:null};}
 if(op==='update'){Object.assign(receipts.find(r=>r.id===filters.id),payload);return{data:null,error:null};}
 return{data:receipts,error:null};
 }
 if(table==='app_state'){
 if(op!=='read')state.set(payload.key,payload.value);
 return{data:filters.key?{value:state.get(filters.key)}:[...state].map(([key,value])=>({key,value})),error:null};
 }
 if(op==='upsert'||op==='insert'){let existing=rows.find(t=>t.row_hash===payload.row_hash);if(existing&&ignore)return{data:[],error:null};const row={id:rows.length+1,...payload};rows.push(row);return{data:[row],error:null};}
 if(op==='update'){const row=rows.find(t=>String(t.id)===String(filters.id));Object.assign(row,payload);return{data:row,error:null};}
 const result=rows.filter(t=>Object.entries(filters).every(([k,v])=>t[k]===v));return{data:q.isSingle?result[0]:result,error:null};
 }).then(resolve,reject);}};return q;}};
 w.Chart={defaults:{font:{},plugins:{legend:{labels:{}},tooltip:{}},scales:{linear:{grid:{}},category:{grid:{}}}}};w.supabase={createClient:()=>client};w.matchMedia=()=>({matches:false,addEventListener(){}});w.scrollTo=()=>{};
 w.URL.createObjectURL=()=> 'blob:test';w.URL.revokeObjectURL=()=>{};
 const ctx=dom.getInternalVMContext();
 for(const file of ['scripts/finance-auth.js','scripts/receipt-parser.js','scripts/transaction-entry.js','scripts/finance-workflows.js'])vm.runInContext(fs.readFileSync(file,'utf8'),ctx);
 let main=[...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].map(m=>m[1]).find(s=>s.includes('const SUPABASE_URL'));
 main=main.replace("window.addEventListener('DOMContentLoaded',initFinanceAuth);",'');
 main=main.replace(/\(async\(\)=>\{try\{await loadFromSupabase\(\);[\s\S]*?\}\}\)\(\);/,'');
 vm.runInContext(main,ctx);vm.runInContext("financeSession={user:{id:'owner',email:'owner@example.test'}};render=()=>{};recomputeAggregates=()=>{};",ctx);
 const set=(id,value)=>w.document.getElementById(id).value=value;
 const fill=()=>{set('qaDate','2026-09-08');set('qaAmount','12.50');set('qaSource','Test merchant');set('qaCategory','Groceries');};
 return{w,ctx,writes,rows,receipts,state,set,fill,failNext:()=>{failSave=true;},close:()=>dom.window.close()};
}
test('manual save persists, editing updates the same row, no duplicate insert',async()=>{
 const a=app();a.w.openQuickAdd();a.fill();await a.w.saveQuickAdd();assert.equal(a.rows.length,1);assert.equal(a.rows[0].value,12.5);assert.match(a.rows[0].row_hash,/^app:/);
 a.w.openQuickAdd(1);a.set('qaAmount','14.20');await a.w.saveQuickAdd();assert.equal(a.rows.length,1);assert.equal(a.rows[0].value,14.2);a.close();
});
test('negative amount and unconfirmed receipt cannot save',async()=>{
 const a=app();a.w.openQuickAdd();a.fill();a.set('qaAmount','-3');await a.w.saveQuickAdd();assert.equal(a.writes.length,0);
 a.set('qaAmount','3');a.w.document.getElementById('receiptReview').hidden=false;await a.w.saveQuickAdd();assert.equal(a.writes.length,0);a.close();
});
test('same-day same-amount duplicate requires explicit confirmation',async()=>{
 const a=app();a.w.openQuickAdd();a.fill();await a.w.saveQuickAdd();a.w.openQuickAdd();a.fill();await a.w.saveQuickAdd();assert.equal(a.rows.length,1);assert.equal(a.w.document.getElementById('qaDuplicate').hidden,false);
 a.w.document.getElementById('qaDuplicateConfirmed').checked=true;await a.w.saveQuickAdd();assert.equal(a.rows.length,2);a.close();
});
test('save failure keeps draft and retry token',async()=>{
 const a=app();a.w.openQuickAdd();a.fill();a.failNext();await a.w.saveQuickAdd();assert.equal(a.w.document.getElementById('qaSource').value,'Test merchant');assert.equal(a.w.document.getElementById('qaSave').disabled,false);
 const token=a.writes[0].payload.row_hash;await a.w.saveQuickAdd();assert.equal(a.rows.length,1);assert.equal(a.rows[0].row_hash,token);a.close();
});
test('imported edit creates durable correction without overlaying a newer server value',async()=>{
 const a=app();a.rows.push({id:42,row_hash:'original-import-hash',date:'2026-09-08',source:'Imported',value:12.5,type:'Outflow'});
 vm.runInContext("FINANCE_ROWS=[{id:42,row_hash:'original-import-hash',date:'2026-09-08',source:'Imported',value:12.5,type:'Outflow'}];ORIGINAL_TXNS=[{id:42,hash:'original-import-hash',d:'2026-09-08',s:'Imported',v:12.5,t:'Out',c:'Food',b:'Cash',r:'',f:''}];TXNS=ORIGINAL_TXNS.map(t=>({...t}));",a.ctx);
 a.w.openQuickAdd(42);a.set('qaAmount','15');await a.w.saveQuickAdd();assert.equal(a.state.get('txn-edit:original-import-hash').fields.value,15);
 await a.w.loadTransactionEdits();assert.equal(a.w.effectiveTransaction({id:42,row_hash:'original-import-hash',value:16}).value,16);a.close();
});

test('receipt matching proposes existing expenses near the receipt date and excludes inflow',()=>{
 const a=app();const r={extracted:{date:'2026-09-08',amount:12.5}};
 const rows=[{id:1,d:'2026-09-09',v:12.5,t:'Out'},{id:2,d:'2026-09-01',v:12.5,t:'Out'},{id:3,d:'2026-09-08',v:12.5,t:'In'},{id:4,d:'2026-09-08',v:15,t:'Out'}];
 assert.deepEqual(Array.from(a.w.receiptMatches(r,rows),x=>x.id),[1]);assert.equal(a.w.receiptMatches({extracted:{amount:null}},rows).length,0);a.close();
});
test('private view escapes uploaded names and merchant HTML, sign out clears finance caches',()=>{
 const a=app();vm.runInContext(`FINANCE_RECEIPTS=[{id:'safe',original_name:'<img src=x onerror=alert(1)>',status:'pending',mime_type:'image/png',extracted:{merchant:'<script>alert(1)</script>'}}];`,a.ctx);
 a.w.renderReview();assert.equal(a.w.document.querySelector('#content script'),null);assert.equal(a.w.document.querySelector('#content img'),null);
 a.w.localStorage.setItem('finance-budgets','private');a.w.localStorage.setItem('chat-anthropic-key','secret');a.w.localStorage.setItem('dash-lang','sl');a.w.clearPrivateDeviceState();assert.equal(a.w.localStorage.getItem('finance-budgets'),null);assert.equal(a.w.localStorage.getItem('chat-anthropic-key'),null);assert.equal(a.w.localStorage.getItem('dash-lang'),'sl');a.close();
});

test('multi-file queue is durable before OCR, survives a failed scan, and skips repeat uploads',async()=>{
 const a=app();let recognized=0;
 a.w.receiptDigest=async buffer=>String(new Uint8Array(buffer)[0]).padStart(64,'0');
 a.w.recognizeReceiptImage=async()=>{assert.ok(a.receipts.length>recognized,'receipt metadata saved before OCR');recognized++;throw new Error('Unreadable photo');};
 const image={name:'receipt.png',type:'image/png',size:1,arrayBuffer:async()=>new Uint8Array([1]).buffer};
 await a.w.uploadReceiptBatch([image,{name:'bad.svg',type:'image/svg+xml',size:1}]);
 assert.equal(a.receipts.length,1);assert.equal(a.rows.length,0);assert.match(a.receipts[0].extracted.read_error,/Unreadable/);assert.match(a.w.document.getElementById('entryNotice').textContent,/bad.svg/);
 await a.w.uploadReceiptBatch([image]);assert.equal(a.receipts.length,1);assert.equal(recognized,1);a.close();
});
test('PDF queue creates one review item per page and never inserts expenses automatically',async()=>{
 const a=app();a.w.receiptDigest=async()=> 'b'.repeat(64);
 a.w.receiptPdfDocument=async()=>({numPages:2,getPage:async n=>({getTextContent:async()=>({items:[{str:'Test shop '+n,transform:[1,0,0,1,0,100],hasEOL:true},{str:'Date: 08.09.2026',transform:[1,0,0,1,0,90],hasEOL:true},{str:'TOTAL EUR 12,50',transform:[1,0,0,1,0,80],hasEOL:true}]}),cleanup(){}}),destroy:async()=>{}});
 await a.w.uploadReceiptBatch([{name:'two.pdf',type:'application/pdf',size:1,arrayBuffer:async()=>new ArrayBuffer(1)}]);
 assert.equal(a.receipts.length,2);assert.deepEqual(a.receipts.map(r=>r.page_number),[1,2]);assert.equal(a.receipts[1].extracted.amount,12.5);assert.equal(a.rows.length,0);a.close();
});
