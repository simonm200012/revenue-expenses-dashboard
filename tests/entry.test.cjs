const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const {JSDOM}=require('jsdom');
const html=fs.readFileSync('index.html','utf8');
function app(){
 const dom=new JSDOM(html,{url:'https://example.test/',runScripts:'outside-only'}),w=dom.window;
 const writes=[],rows=[],state=new Map();let failSave=false;
 const client={from(table){let op='read',payload,filters={},ignore=false;const q={select(){return q;},order(){return q;},range(){return q;},like(){return q;},in(){return q;},eq(k,v){filters[k]=v;return q;},maybeSingle(){return q;},single(){q.isSingle=true;return q;},insert(v){op='insert';payload=v;return q;},upsert(v,options){op='upsert';payload=v;ignore=options?.ignoreDuplicates;return q;},update(v){op='update';payload=v;return q;},then(resolve,reject){return Promise.resolve().then(()=>{
 if(op!=='read')writes.push({table,op,payload});
 if(op!=='read'&&table==='transactions'&&failSave){failSave=false;return{data:null,error:{message:'Connection lost'}};}
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
 for(const file of ['scripts/receipt-parser.js','scripts/transaction-entry.js'])vm.runInContext(fs.readFileSync(file,'utf8'),ctx);
 let main=[...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].map(m=>m[1]).find(s=>s.includes('const SUPABASE_URL'));
 main=main.replace(/\(async\(\)=>\{try\{await loadFromSupabase\(\);[\s\S]*?\}\}\)\(\);/,'');
 vm.runInContext(main,ctx);vm.runInContext('render=()=>{};recomputeAggregates=()=>{};',ctx);
 const set=(id,value)=>w.document.getElementById(id).value=value;
 const fill=()=>{set('qaDate','2026-09-08');set('qaAmount','12.50');set('qaSource','Test merchant');set('qaCategory','Groceries');};
 return{w,ctx,writes,rows,state,set,fill,failNext:()=>{failSave=true;},close:()=>dom.window.close()};
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
test('imported edit creates durable correction and is reapplied on reload',async()=>{
 const a=app();a.rows.push({id:42,row_hash:'original-import-hash',date:'2026-09-08',source:'Imported',value:12.5,type:'Outflow'});
 vm.runInContext("ORIGINAL_TXNS=[{id:42,hash:'original-import-hash',d:'2026-09-08',s:'Imported',v:12.5,t:'Out',c:'Food',b:'Cash',r:'',f:''}];TXNS=ORIGINAL_TXNS.map(t=>({...t}));",a.ctx);
 a.w.openQuickAdd(42);a.set('qaAmount','15');await a.w.saveQuickAdd();assert.equal(a.state.get('txn-edit:original-import-hash').fields.value,15);
 await a.w.loadTransactionEdits();assert.equal(a.w.effectiveTransaction({id:42,row_hash:'original-import-hash',value:12.5}).value,15);a.close();
});
