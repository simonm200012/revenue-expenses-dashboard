const {test}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),crypto=require('node:crypto');
const source=fs.readFileSync('apps-script/Code.gs','utf8');
function environment({failCorrections=false,failBatch=false,count=1}={}){
 const posts=[],props=new Map(),stored=new Map();let released=false,now=Date.parse('2026-10-03T04:00:00Z'),serial=0;
 const header=['Date','Date 2','Value','Source','Bank','Type','Detail','Category','Discount','Final','Reconciled'];
 const sheet=[header,...Array.from({length:count},(_,i)=>['2026-09-08',null,12.5,'SHOP'+(i||''),'Cash','Outflow','Food','Groceries',null,'Groceries',null])];
 const timers=[{getHandlerFunction:()=> 'syncToSupabase',getUniqueId:()=> 'daily'},{getHandlerFunction:()=> 'backupFinanceDaily',getUniqueId:()=> 'backup'}];
 const response=(code,body=[])=>({getResponseCode:()=>code,getContentText:()=>JSON.stringify(body)});
 class Clock extends Date {constructor(...args){super(...(args.length?args:[now]));}static now(){return now;}}
 const config={batchError:failBatch?500:0,correctionError:failCorrections?403:0,failAfter:0,statusError:0,networkAfterCommit:false,locked:false,triggerError:false};
 const ctx=vm.createContext({Date:Clock,Number,JSON,Object,Error,
 PropertiesService:{getScriptProperties:()=>({getProperty:k=>['SUPABASE_KEY','FINANCE_WORKER_TOKEN','SPREADSHEET_ID'].includes(k)?'test-key':props.get(k)||null,setProperty:(k,v)=>props.set(k,v)})},
 Utilities:{DigestAlgorithm:{MD5:'md5',SHA_256:'sha256'},computeDigest:(alg,s)=>[...crypto.createHash(alg).update(s).digest()],getUuid:()=> 'run-'+(++serial),sleep:ms=>{now+=ms;}},
 Logger:{log(){}},LockService:{getScriptLock:()=>({tryLock:()=>!config.locked,releaseLock:()=>{released=true;}})},
 SpreadsheetApp:{openById:()=>({getSheetByName:()=>({getDataRange:()=>({getValues:()=>sheet})})})},
 UrlFetchApp:{fetch:(url,req)=>{
 posts.push(req);
 if(url.includes('select=key'))return response(config.correctionError||200);
 if(url.includes('/transactions')){
  const rows=JSON.parse(req.payload);
  if(config.batchError&&stored.size>=config.failAfter)return response(config.batchError);
  rows.forEach(r=>stored.set(r.row_hash,r));
  if(config.networkAfterCommit)throw Error('Sensitive upstream response should never be published');
  return response(201);
 }
 return response(config.statusError||201);
 }},
 ScriptApp:{getProjectTriggers:()=>timers.slice(),deleteTrigger:t=>{timers.splice(timers.indexOf(t),1);},newTrigger:handler=>{
  let delay;const builder={timeBased:()=>builder,after:ms=>{delay=ms;return builder;},create:()=>{if(config.triggerError)throw Error('quota');const id='timer-'+(++serial);const t={getHandlerFunction:()=>handler,getUniqueId:()=>id,delay};timers.push(t);return t;}};return builder;
 }}});
 vm.runInContext(source,ctx);
 return{ctx,sheet,posts,props,stored,timers,config,released:()=>released,advance:ms=>{now+=ms;},state:()=>JSON.parse(props.get('FINANCE_SYNC_RUN_V2')),recover:()=>ctx.financeSyncRecovery({triggerUid:JSON.parse(props.get('FINANCE_SYNC_RUN_V2')).recovery_trigger_id})};
}
test('hash matches previous importer and app correction survives repeated imports',()=>{
 const {ctx,sheet}=environment();const row=ctx.buildSyncRows(sheet,{})[0];
 const expected=crypto.createHash('md5').update(['2026-09-08',12.5,'SHOP','Cash','Outflow','Food','Groceries',1].join('|')).digest('hex');assert.equal(row.row_hash,expected);
 const edits={[expected]:{value:14.2,source:'Corrected'}};assert.equal(ctx.buildSyncRows(sheet,edits)[0].value,14.2);assert.equal(ctx.buildSyncRows(sheet,edits)[0].row_hash,expected);
});
test('sync has no deletion and records success',()=>{const e=environment();e.ctx.syncToSupabase();assert.ok(e.posts.every(r=>r.method!=='delete'));assert.ok(e.posts.some(r=>r.payload?.includes('"status":"success"')));assert.ok(e.released());});
test('unavailable corrections stop import instead of reverting app edits',()=>{const e=environment({failCorrections:true});assert.throws(()=>e.ctx.syncToSupabase(),/Reading saved app corrections/);assert.equal(e.posts.filter(r=>r.url.includes('/transactions')).length,0);assert.ok(e.released());});
test('HTTP failure is surfaced to Apps Script notifications',()=>{const e=environment({failBatch:true});assert.throws(()=>e.ctx.syncToSupabase(),/HTTP 500/);assert.ok(e.posts.some(r=>r.payload?.includes('"status":"retry_wait"')));});
test('full replace disabled and duplicate triggers retained',()=>{const e=environment();assert.throws(()=>e.ctx.fullReplaceSync(),/disabled/);e.ctx.createDailyTrigger();assert.equal(e.posts.length,0);});
test('backup uses one consistent snapshot, uploads gzip and inserts metadata without upsert',()=>{
 const e=environment(),requests=[];const snapshot={format_version:1,created_at:'2026-09-08T08:00:00Z',transactions:[{id:1}],app_state:[],finance_receipts:[],finance_history:[]};
 Object.assign(e.ctx.Utilities,{DigestAlgorithm:{MD5:'md5',SHA_256:'sha256'},computeDigest:(alg,s)=>[...crypto.createHash(alg).update(Buffer.from(s)).digest()],newBlob:s=>s,gzip:s=>({getBytes:()=>[...require('node:zlib').gzipSync(s)]}),formatDate:()=> '2026-09-08',getUuid:()=> 'synthetic'});
 e.ctx.UrlFetchApp.fetch=(url,req)=>{requests.push(req);if(url.endsWith('finance_export_snapshot'))return{getResponseCode:()=>200,getContentText:()=>JSON.stringify(snapshot)};return{getResponseCode:()=>201};};
 e.ctx.backupFinanceDaily();assert.equal(requests.length,3);assert.equal(requests[0].url.endsWith('/rpc/finance_export_snapshot'),true);assert.equal(requests[1].headers['Cache-Control'],'max-age=0');assert.equal(requests[2].headers.Prefer,'return=minimal');
 const indexed=JSON.parse(requests[2].payload);assert.equal(indexed.row_count,1);assert.equal(indexed.sha256,crypto.createHash('sha256').update(Buffer.from(requests[1].payload)).digest('hex'));assert.ok(e.released());
});

test('transient failures resume only acknowledged batches with bounded network retries',()=>{
 const e=environment({count:1001});e.config.batchError=503;e.config.failAfter=500;
 assert.throws(()=>e.ctx.syncToSupabase(),/HTTP 503/);
 assert.equal(e.state().status,'retry_wait');assert.equal(e.state().processed_rows,500);
 assert.equal(e.posts.filter(r=>r.url.includes('/transactions')).length,4);
 assert.equal(e.timers.filter(t=>t.getHandlerFunction()==='financeSyncRecovery').length,1);
 e.config.batchError=0;const previous=e.posts.length;e.recover();
 assert.equal(e.state().status,'success');assert.equal(e.state().attempt,2);assert.equal(e.stored.size,1001);
 assert.equal(e.posts.slice(previous).filter(r=>r.url.includes('/transactions')).length,2);
 assert.deepEqual(e.timers.map(t=>t.getUniqueId()),['daily','backup']);
});
test('changed input or correction fingerprints restart instead of skipping old offsets',()=>{
 const e=environment({count:1001});e.config.batchError=503;e.config.failAfter=500;
 assert.throws(()=>e.ctx.syncToSupabase());
 // final_category is deliberately absent from the historical row hash.
 e.sheet[1][9]='Corrected category';e.config.batchError=0;const previous=e.posts.length;e.recover();
 assert.equal(e.posts.slice(previous).filter(r=>r.url.includes('/transactions')).length,3);
 assert.equal(e.stored.size,1001);assert.equal([...e.stored.values()][0].final_category,'Corrected category');
});
test('ambiguous commits are idempotent and private server error text is not published',()=>{
 const e=environment();e.config.networkAfterCommit=true;assert.throws(()=>e.ctx.syncToSupabase(),/connection/);
 assert.equal(e.stored.size,1);assert.equal(e.state().processed_rows,0);
 assert.ok(!e.props.get('FINANCE_SYNC_RUN_V2').includes('Sensitive upstream'));
 e.config.networkAfterCommit=false;e.recover();assert.equal(e.stored.size,1);assert.equal(e.state().status,'success');
});
test('hard-killed runs recover from persistent state and cannot retry indefinitely',()=>{
 const e=environment();e.config.batchError=503;assert.throws(()=>e.ctx.syncToSupabase());
 let state=e.state();state.status='running';state.attempt=3;e.props.set('FINANCE_SYNC_RUN_V2',JSON.stringify(state));
 const before=e.posts.filter(r=>r.url.includes('/transactions')).length;
 assert.throws(()=>e.recover(),/three attempts/);
 assert.equal(e.state().status,'failed');assert.equal(e.state().next_retry_at,null);
 assert.equal(e.posts.filter(r=>r.url.includes('/transactions')).length,before);
 assert.equal(e.timers.length,2);
});
test('persistent HTTP and validation failures stop without retrying destructive actions',()=>{
 const e=environment();e.config.batchError=403;assert.throws(()=>e.ctx.syncToSupabase(),/403/);
 assert.equal(e.posts.filter(r=>r.url.includes('/transactions')).length,1);assert.equal(e.state().status,'failed');assert.equal(e.timers.length,2);
 const v=environment();v.sheet[0][0]='Unexpected';assert.throws(()=>v.ctx.syncToSupabase(),/layout/);
 assert.equal(v.posts.filter(r=>r.url.includes('/transactions')).length,0);assert.equal(v.state().status,'failed');
});
test('a delayed timer cannot replace a newer successful run',()=>{
 const e=environment();e.config.batchError=503;assert.throws(()=>e.ctx.syncToSupabase());const old=e.state().recovery_trigger_id;
 e.config.batchError=0;e.ctx.syncToSupabase();const count=e.posts.length;
 e.ctx.financeSyncRecovery({triggerUid:old});assert.equal(e.posts.length,count);assert.equal(e.state().status,'success');
});
test('recovery timer is armed before network work and configuration errors do not pretend a retry exists',()=>{
 const e=environment();e.config.triggerError=true;assert.throws(()=>e.ctx.syncToSupabase(),/schedule import recovery/);
 assert.equal(e.posts.filter(r=>r.url.includes('/transactions')).length,0);assert.equal(e.state().status,'failed');assert.equal(e.state().next_retry_at,null);
 const f=environment();f.config.statusError=503;assert.throws(()=>f.ctx.syncToSupabase(),/Updating import status/);
 assert.equal(f.state().status,'retry_wait');assert.equal(f.timers.length,3);
});
test('backup lock contention schedules a wake-up without overwriting job state',()=>{
 const e=environment();e.config.batchError=503;assert.throws(()=>e.ctx.syncToSupabase());const previous=e.state().recovery_trigger_id;
 const saved=e.props.get('FINANCE_SYNC_RUN_V2');
 e.advance(8*60000);e.config.locked=true;e.recover();
 assert.equal(e.state().recovery_trigger_id,previous);assert.equal(e.props.get('FINANCE_SYNC_RUN_V2'),saved);
 assert.equal(e.timers.filter(t=>t.getHandlerFunction()==='financeSyncRecoveryWake').length,1);assert.equal(e.state().attempt,1);
 e.config.locked=false;e.config.batchError=0;e.ctx.syncToSupabase();const calls=e.posts.length;
 e.ctx.financeSyncRecoveryWake();assert.equal(e.posts.length,calls);assert.equal(e.state().status,'success');assert.equal(e.timers.length,2);
});
test('request limits leave time for status handling and preserve authenticated transport',()=>{
 const e=environment();e.ctx.syncToSupabase();
 for(const r of e.posts){assert.ok(r.timeoutSeconds<=30);assert.ok(r.headers['x-finance-worker']);assert.notEqual(r.validateHttpsCertificates,false);}
 assert.equal(e.state().last_success_at,e.state().finished_at);
});
test('terminal failure delivery is retried without restarting completed row attempts',()=>{
 const e=environment();e.config.batchError=503;assert.throws(()=>e.ctx.syncToSupabase());
 const state=e.state();state.attempt=3;state.status='running';e.props.set('FINANCE_SYNC_RUN_V2',JSON.stringify(state));
 e.config.statusError=503;assert.throws(()=>e.recover(),/three attempts/);
 assert.equal(e.state().status,'failed');assert.equal(e.state().status_pending,true);assert.equal(e.state().status_delivery_attempts,1);
 const rows=e.posts.filter(r=>r.url.includes('/transactions')).length;
 e.config.statusError=0;e.recover();
 assert.equal(e.state().status_pending,false);assert.equal(e.state().status,'failed');assert.equal(e.state().status_delivery_attempts,2);
 assert.equal(e.posts.filter(r=>r.url.includes('/transactions')).length,rows);assert.equal(e.timers.length,2);
 assert.equal(JSON.parse(e.posts.at(-1).payload).value.status,'failed');
 assert.ok(!e.posts.at(-1).payload.includes('status_pending'));
});
test('status-only delivery stops after three tries even when an execution was killed',()=>{
 const e=environment();e.config.batchError=503;assert.throws(()=>e.ctx.syncToSupabase());
 const state=e.state();state.attempt=3;state.status='failed';state.status_pending=true;state.status_delivery_attempts=3;
 e.props.set('FINANCE_SYNC_RUN_V2',JSON.stringify(state));const before=e.posts.length;
 assert.throws(()=>e.recover(),/status could not be delivered/);assert.equal(e.posts.length,before);
 assert.equal(e.state().status_pending,false);assert.equal(e.timers.length,2);
});
test('failed final success acknowledgment resumes progress and preserves prior last success',()=>{
 const e=environment({count:501});e.props.set('FINANCE_SYNC_LAST_SUCCESS','2026-10-02T04:00:00.000Z');
 const original=e.ctx.UrlFetchApp.fetch;e.ctx.UrlFetchApp.fetch=(url,req)=>{
  if(req.payload?.includes('"status":"success"')){e.posts.push(req);return{getResponseCode:()=>503};}
  return original(url,req);
 };
 assert.throws(()=>e.ctx.syncToSupabase(),/Updating import status/);
 assert.equal(e.state().processed_rows,501);assert.equal(e.state().status,'retry_wait');
 assert.equal(e.state().last_success_at,'2026-10-02T04:00:00.000Z');
 e.ctx.UrlFetchApp.fetch=original;const before=e.posts.length;e.recover();
 assert.equal(e.posts.slice(before).filter(r=>r.url.includes('/transactions')).length,0);assert.equal(e.state().status,'success');
});
test('soft deadline checkpoints progress before the next batch and leaves a recovery timer',()=>{
 const e=environment({count:501});const original=e.ctx.UrlFetchApp.fetch;
 e.ctx.UrlFetchApp.fetch=(url,req)=>{const result=original(url,req);if(url.includes('/transactions'))e.advance(190000);return result;};
 assert.throws(()=>e.ctx.syncToSupabase(),/paused before its time limit/);
 assert.equal(e.state().processed_rows,500);assert.equal(e.state().status,'retry_wait');assert.equal(e.timers.length,3);
 e.ctx.UrlFetchApp.fetch=original;e.recover();assert.equal(e.stored.size,501);assert.equal(e.state().status,'success');
});
