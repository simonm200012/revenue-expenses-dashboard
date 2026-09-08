const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const {JSDOM}=require('jsdom');
const html=fs.readFileSync('index.html','utf8');
const ownerSession={user:{id:'owner-test',email:'simonm2000@outlook.com'}};
function app(options={}){
  const dom=new JSDOM(html,{url:'https://example.test/',runScripts:'outside-only'}),w=dom.window,ctx=dom.getInternalVMContext();
  const calls={signIn:[],updates:[],loads:0,renders:0,subscriptions:0};
  let authChanged;
  w._supabase={auth:{
    signInWithPassword:async credentials=>{calls.signIn.push(credentials);authChanged?.('SIGNED_IN',ownerSession);return options.signInResult||{data:{session:ownerSession}};},
    updateUser:async fields=>{calls.updates.push(fields);return options.updateResult||{data:{user:ownerSession.user}};},
    getSession:async()=>({data:{session:options.session||null}}),
    onAuthStateChange:handler=>{calls.subscriptions++;authChanged=handler;},
    signOut:async()=>({error:null})
  },rpc:async name=>{assert.equal(name,'finance_is_owner');return options.ownerCheck?options.ownerCheck():{data:options.owner!==false};}};
  w.loadFromSupabase=async()=>{calls.loads++;};w.render=()=>{calls.renders++;};w.restoreStateFromHash=()=>{};w.disposePrivateReceipts=()=>{};
  vm.runInContext('let TXNS=[],ORIGINAL_TXNS=[],T212_DATA=null;',ctx);
  vm.runInContext(fs.readFileSync('scripts/finance-auth.js','utf8'),ctx);
  const set=(id,value)=>w.document.getElementById(id).value=value;
  const input=id=>w.document.getElementById(id);
  return {w,ctx,calls,set,input,authChanged:(event,session)=>authChanged(event,session),close:()=>dom.window.close()};
}
test('username/password login validates with Supabase and loads only the server-confirmed owner',async()=>{
  const a=app();await a.w.initFinanceAuth();
  a.set('financeUsername',' SIMON ');a.set('financePassword','synthetic-fixture-only');
  await a.w.signInFinance();
  assert.equal(a.calls.signIn.length,1);assert.equal(a.calls.signIn[0].email,ownerSession.user.email);
  assert.equal(a.calls.signIn[0].password,'synthetic-fixture-only');
  assert.equal(a.calls.loads,1);assert.equal(a.calls.renders,1);
  assert.equal(a.input('app').hidden,false);assert.equal(a.input('financeAuth').hidden,true);
  assert.equal(a.input('financePassword').value,'');assert.equal(a.w.localStorage.length,0);
  assert.equal(a.input('financeSignedInAs').textContent,'simon');a.close();
});
test('wrong username and wrong password keep the dashboard locked and clear the password',async()=>{
  const a=app({signInResult:{error:{code:'invalid_credentials',message:'Internal detail'}}});
  a.set('financeUsername','someone-else');a.set('financePassword','synthetic-fixture-only');await a.w.signInFinance();
  assert.equal(a.calls.signIn.length,0);const generic=a.input('financeAuthStatus').textContent;
  a.set('financeUsername','simon');a.set('financePassword','synthetic-fixture-only');await a.w.signInFinance();
  assert.equal(a.input('financeAuthStatus').textContent,generic);assert.equal(a.calls.loads,0);
  assert.equal(a.input('app').hidden,true);assert.equal(a.input('financePassword').value,'');
  assert.equal(a.input('financeSignIn').disabled,false);a.close();
});
test('a session without owner permission never loads financial data',async()=>{
  const a=app({owner:false});a.set('financeUsername','simon');a.set('financePassword','synthetic-fixture-only');
  await a.w.signInFinance();assert.equal(a.calls.loads,0);assert.equal(a.input('app').hidden,true);
  assert.match(a.input('financeAuthStatus').textContent,/does not have access/);a.close();
});
test('retry restores a persisted session without another password or auth listener',async()=>{
  const a=app({session:ownerSession});await a.w.initFinanceAuth();await a.w.initFinanceAuth();
  assert.equal(a.calls.signIn.length,0);assert.equal(a.calls.subscriptions,1);assert.equal(a.input('app').hidden,false);a.close();
});
test('signing out while owner validation is pending prevents loading financial data',async()=>{
  let resolveOwner;const a=app({ownerCheck:()=>new Promise(resolve=>{resolveOwner=resolve;})});
  await a.w.initFinanceAuth();const pending=a.w.acceptFinanceSession(ownerSession);
  a.authChanged('SIGNED_OUT',null);resolveOwner({data:true});await pending;
  assert.equal(a.calls.loads,0);assert.equal(a.input('app').hidden,true);a.close();
});
test('password setup requires an owner session and matching fields before updating Auth',async()=>{
  const a=app();a.set('financeNewPassword','synthetic-fixture-only');a.set('financeConfirmPassword','synthetic-fixture-only');
  await a.w.saveFinancePassword();assert.equal(a.calls.updates.length,0);assert.equal(a.input('financeNewPassword').value,'');
  await a.w.acceptFinanceSession(ownerSession);
  a.set('financeNewPassword','synthetic-fixture-only');a.set('financeConfirmPassword','different-fixture');
  await a.w.saveFinancePassword();assert.equal(a.calls.updates.length,0);assert.match(a.input('financePasswordStatus').textContent,/do not match/);
  a.set('financeConfirmPassword','synthetic-fixture-only');await a.w.saveFinancePassword();
  assert.equal(a.calls.updates.length,1);assert.equal(a.calls.updates[0].password,'synthetic-fixture-only');
  assert.equal(a.input('financeNewPassword').value,'');assert.equal(a.input('financeConfirmPassword').value,'');
  assert.match(a.input('financePasswordStatus').textContent,/Password saved/);assert.equal(a.w.localStorage.length,0);a.close();
});
test('failed password updates do not retain either password or display internal errors',async()=>{
  const a=app({session:ownerSession,updateResult:{error:{code:'weak_password',message:'Internal detail'}}});
  await a.w.initFinanceAuth();a.set('financeNewPassword','synthetic-fixture-only');a.set('financeConfirmPassword','synthetic-fixture-only');
  await a.w.saveFinancePassword();assert.match(a.input('financePasswordStatus').textContent,/stronger password/);
  assert.equal(a.input('financeNewPassword').value,'');assert.equal(a.input('financeConfirmPassword').value,'');assert.equal(a.input('financeSavePassword').disabled,false);a.close();
});
