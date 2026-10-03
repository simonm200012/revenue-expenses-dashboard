const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const {JSDOM}=require('jsdom');
const {describe,timestamp}=require('../scripts/sync-status.js');
const now=Date.parse('2026-10-03T08:00:00Z');
const status=(record,options={})=>describe(record,{now,...options});
const row=(view,label)=>view.rows.find(item=>item.label===label)?.value;

test('an old running record explains missing progress without claiming a timeout',()=>{
  const view=status({status:'running',started_at:'2026-09-17T04:13:00Z',row_count:3325});
  assert.equal(view.state,'stalled');assert.match(view.title,/stopped reporting progress/);
  assert.match(view.message,/may have ended/);assert.doesNotMatch(view.message,/timed out|failed/);
  assert.equal(row(view,'Rows in this import'),'3,325');assert.match(view.reassurance,/save immediately/);
});
test('new heartbeat keeps a long-running job current and exposes stage and progress',()=>{
  const view=status({status:'running',started_at:'2026-10-03T07:00:00Z',attempt_started_at:'2026-10-03T07:56:00Z',updated_at:'2026-10-03T07:59:00Z',row_count:3325,processed_rows:2500,stage:'uploading',attempt:2,max_attempts:3,last_success_at:'2026-10-02T04:15:00Z'});
  assert.equal(view.state,'running');assert.equal(row(view,'Rows processed'),'2,500 / 3,325');
  assert.equal(row(view,'Stage'),'Saving imported rows');assert.equal(row(view,'Attempt'),'2 / 3');
  assert.ok(row(view,'Last successful import'));assert.ok(row(view,'Current attempt started'));
});
test('retry scheduled, due and overdue are distinct; no scheduled time is not invented',()=>{
  const base={status:'retry_wait',attempt:1,max_attempts:3,error:'Temporary upload failure.'};
  assert.equal(status({...base,next_retry_at:'2026-10-03T08:05:00Z'}).state,'retry_scheduled');
  assert.equal(status({...base,next_retry_at:'2026-10-03T07:59:00Z'}).state,'retry_due');
  assert.equal(status({...base,next_retry_at:'2026-10-03T07:50:00Z'}).state,'retry_overdue');
  assert.equal(status(base).state,'retry_unknown_time');
});
test('malformed dates, counts and records never become success times or misleading progress',()=>{
  for(const invalid of [null,0,'', 'not a date','2026-02-30T04:00:00Z','2026-10-03T25:00:00Z'])assert.equal(timestamp(invalid),null);
  const bad=status({status:'running',started_at:'yesterday',updated_at:'invalid',row_count:-3,processed_rows:'20',attempt:{}});
  assert.equal(bad.state,'running_unknown_time');assert.equal(bad.rows.length,0);
  assert.doesNotMatch(JSON.stringify(bad),/Invalid Date|NaN|undefined/);
  assert.equal(status({status:'success',finished_at:'2026-02-30T04:00:00Z'}).state,'success_unknown_time');
  assert.equal(status([]).state,'unknown');
});
test('old successful import is overdue while a recent new success shows the confirmed total',()=>{
  const old=status({status:'success',started_at:'2026-09-17T04:13:00Z',finished_at:'2026-09-17T04:15:00Z',row_count:3325});
  assert.equal(old.state,'overdue');assert.ok(row(old,'Last successful import'));
  const current=status({status:'success',started_at:'2026-10-03T04:13:00Z',finished_at:'2026-10-03T04:15:00Z',last_success_at:'2026-10-03T04:15:00Z',row_count:3330,processed_rows:3330,attempt:1,max_attempts:3});
  assert.equal(current.state,'success');assert.equal(row(current,'Rows synced'),'3,330');assert.equal(current.tone,'muted');
  const failed=status({status:'failed',last_success_at:'2026-09-17T04:15:00Z',error:'Upload failed after 3 attempts.'});
  assert.equal(failed.state,'failed');assert.ok(row(failed,'Last successful import'));
  assert.match(row(failed,'Reported error'),/3 attempts/);
});
test('Slovenian labels and unavailable fetch status are honest',()=>{
  const view=status({status:'success',finished_at:'2026-10-03T04:15:00Z'},{lang:'sl'});
  assert.match(view.title,/Preglednica posodobljena/);assert.match(view.reassurance,/shranijo takoj/);
  const unavailable=status({status:'success',finished_at:'2026-10-03T04:15:00Z'},{unavailable:true});
  assert.equal(unavailable.state,'unavailable');assert.equal(unavailable.rows.length,0);assert.doesNotMatch(unavailable.title,/synced/);
});

function ui(){
  const dom=new JSDOM('<div id="sheetsSyncStatus"></div><div id="quickAddPanel"></div>',{url:'https://example.test/',runScripts:'outside-only'});
  const w=dom.window;let resolve;
  w.financeSession={user:{id:'owner'}};w.financeAuthEpoch=1;w.CURRENT_LANG='en';
  w._supabase={from(){const q={select(){return q;},eq(){return q;},maybeSingle(){return new Promise(r=>{resolve=r;});}};return q;}};
  w.eval(fs.readFileSync('scripts/sync-status.js','utf8'));
  w.eval(fs.readFileSync('scripts/transaction-entry.js','utf8'));
  return {w,dom,respond:value=>resolve(value),close:()=>dom.window.close()};
}
test('sync details render errors as text and refresh reads only the saved status',async()=>{
  const a=ui();const pending=a.w.refreshSyncStatus();
  a.respond({data:{value:{status:'failed',error:'<img src=x onerror=alert(1)><script>alert(1)</script>'}},error:null});await pending;
  const node=a.w.document.getElementById('sheetsSyncStatus');
  assert.equal(node.querySelector('img,script'),null);assert.match(node.textContent,/<img src=x/);
  assert.equal(node.querySelector('a').getAttribute('rel'),'noopener noreferrer');
  assert.match(node.querySelector('a').href,/\/executions$/);
  assert.equal(node.querySelectorAll('button').length,1);
  node.querySelector('details').open=true;const next=a.w.refreshSyncStatus();assert.equal(node.querySelector('button').disabled,true);
  a.respond({error:{message:'Network error'}});await next;
  assert.match(node.textContent,/status unavailable/);assert.equal(node.querySelector('details').open,true);assert.equal(node.querySelector('button').disabled,false);a.close();
});
test('sign-out clears sync metadata and discards an in-flight response',async()=>{
  const a=ui();const pending=a.w.refreshSyncStatus();
  a.w.financeSession=null;a.w.financeAuthEpoch++;a.w.clearSheetsSyncStatus();
  a.respond({data:{value:{status:'failed',error:'Private run detail'}},error:null});await pending;
  const node=a.w.document.getElementById('sheetsSyncStatus');assert.equal(node.textContent,'');assert.equal(node.hasAttribute('aria-busy'),false);a.close();
});
