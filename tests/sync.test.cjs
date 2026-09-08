const {test}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),crypto=require('node:crypto');
const source=fs.readFileSync('apps-script/Code.gs','utf8');
function environment({failCorrections=false,failBatch=false}={}){
 const posts=[];let released=false;
 const sheet=[['Date','Date 2','Value','Source','Bank','Type','Detail','Category','Discount','Final','Reconciled'],['2026-09-08',null,12.5,'SHOP','Cash','Outflow','Food','Groceries',null,'Groceries',null]];
 const response=(code,body=[])=>({getResponseCode:()=>code,getContentText:()=>JSON.stringify(body)});
 const ctx=vm.createContext({Date,Number,JSON,Object,Error,PropertiesService:{getScriptProperties:()=>({getProperty:()=> 'test-key'})},Utilities:{DigestAlgorithm:{MD5:'md5'},computeDigest:(_,s)=>[...crypto.createHash('md5').update(s).digest()]},Logger:{log(){}},LockService:{getScriptLock:()=>({tryLock:()=>true,releaseLock:()=>{released=true;}})},SpreadsheetApp:{openById:()=>({getSheetByName:()=>({getDataRange:()=>({getValues:()=>sheet})})})},UrlFetchApp:{fetch:(url,req)=>{posts.push(req);return url.includes('select=key')?response(failCorrections?403:200):response(201);},fetchAll:requests=>{posts.push(...requests);return requests.map(()=>response(failBatch?500:201));}},ScriptApp:{getProjectTriggers:()=>[{getHandlerFunction:()=> 'syncToSupabase'}]}});
 vm.runInContext(source,ctx);return{ctx,sheet,posts,released:()=>released};
}
test('hash matches previous importer and app correction survives repeated imports',()=>{
 const {ctx,sheet}=environment();const row=ctx.buildSyncRows(sheet,{})[0];
 const expected=crypto.createHash('md5').update(['2026-09-08',12.5,'SHOP','Cash','Outflow','Food','Groceries',1].join('|')).digest('hex');assert.equal(row.row_hash,expected);
 const edits={[expected]:{value:14.2,source:'Corrected'}};assert.equal(ctx.buildSyncRows(sheet,edits)[0].value,14.2);assert.equal(ctx.buildSyncRows(sheet,edits)[0].row_hash,expected);
});
test('sync has no deletion and records success',()=>{const e=environment();e.ctx.syncToSupabase();assert.ok(e.posts.every(r=>r.method!=='delete'));assert.ok(e.posts.some(r=>r.payload?.includes('"status":"success"')));assert.ok(e.released());});
test('unavailable corrections stop import instead of reverting app edits',()=>{const e=environment({failCorrections:true});assert.throws(()=>e.ctx.syncToSupabase(),/Cannot read app corrections/);assert.equal(e.posts.filter(r=>r.url.includes('/transactions')).length,0);assert.ok(e.released());});
test('HTTP failure is surfaced to Apps Script notifications',()=>{const e=environment({failBatch:true});assert.throws(()=>e.ctx.syncToSupabase(),/HTTP 500/);assert.ok(e.posts.some(r=>r.payload?.includes('"status":"failed"')));});
test('full replace disabled and duplicate triggers retained',()=>{const e=environment();assert.throws(()=>e.ctx.fullReplaceSync(),/disabled/);e.ctx.createDailyTrigger();assert.equal(e.posts.length,0);});
test('backup uses one consistent snapshot, uploads gzip and inserts metadata without upsert',()=>{
 const e=environment(),requests=[];const snapshot={format_version:1,created_at:'2026-09-08T08:00:00Z',transactions:[{id:1}],app_state:[],finance_receipts:[],finance_history:[]};
 Object.assign(e.ctx.Utilities,{DigestAlgorithm:{MD5:'md5',SHA_256:'sha256'},computeDigest:(alg,s)=>[...crypto.createHash(alg).update(Buffer.from(s)).digest()],newBlob:s=>s,gzip:s=>({getBytes:()=>[...require('node:zlib').gzipSync(s)]}),formatDate:()=> '2026-09-08',getUuid:()=> 'synthetic'});
 e.ctx.UrlFetchApp.fetch=(url,req)=>{requests.push(req);if(url.endsWith('finance_export_snapshot'))return{getResponseCode:()=>200,getContentText:()=>JSON.stringify(snapshot)};return{getResponseCode:()=>201};};
 e.ctx.backupFinanceDaily();assert.equal(requests.length,3);assert.equal(requests[0].url.endsWith('/rpc/finance_export_snapshot'),true);assert.equal(requests[1].headers['Cache-Control'],'max-age=0');assert.equal(requests[2].headers.Prefer,'return=minimal');
 const indexed=JSON.parse(requests[2].payload);assert.equal(indexed.row_count,1);assert.equal(indexed.sha256,crypto.createHash('sha256').update(Buffer.from(requests[1].payload)).digest('hex'));assert.ok(e.released());
});
