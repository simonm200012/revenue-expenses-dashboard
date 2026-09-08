// Supabase validates identity; database and storage policies enforce ownership.
let financeSession=null,financeBooting=false,financeAuthEpoch=0;
async function requestFinanceCode(event){
  event?.preventDefault();
  const email=document.getElementById('financeEmail').value.trim();
  const status=document.getElementById('financeAuthStatus'),button=document.getElementById('financeSendCode');
  if(!email)return;
  button.disabled=true;status.textContent='Sending your sign-in code…';
  try{
    const {error}=await _supabase.auth.signInWithOtp({email,options:{emailRedirectTo:location.origin+location.pathname,shouldCreateUser:true}});
    if(error)throw error;
    document.getElementById('financeCodeStep').hidden=false;
    status.textContent='Check your email for a code. Enter it below to continue.';
    document.getElementById('financeCode').focus();
  }catch(error){status.textContent=error.message||'Could not send a code. Please try again.';}
  finally{button.disabled=false;}
}
async function verifyFinanceCode(event){
  event?.preventDefault();
  const button=document.getElementById('financeVerifyCode'),status=document.getElementById('financeAuthStatus');
  button.disabled=true;status.textContent='Checking your code…';
  try{
    const {data,error}=await _supabase.auth.verifyOtp({email:document.getElementById('financeEmail').value.trim(),token:document.getElementById('financeCode').value.trim(),type:'email'});
    if(error)throw error;
    await acceptFinanceSession(data.session);
  }catch(error){status.textContent=error.message||'Could not sign in.';}
  finally{button.disabled=false;}
}
function clearPrivateDeviceState(){
  // Preserve visual preferences. Financial caches must not survive sign-out.
  for(const key of Object.keys(localStorage))if(key!=='fin-theme'&&(/^(fin-|finance-|plan-|dash-ai-|chat-)/.test(key)||key==='cat-view-v1'))localStorage.removeItem(key);
  TXNS=[];ORIGINAL_TXNS=[];T212_DATA=null;
  document.getElementById('chatMsgs').replaceChildren();document.getElementById('chatApiKey').value='';document.getElementById('chatInput').value='';
  for(const id of ['quickAddPanel','chatPanel','filterPanel','navPane'])document.getElementById(id)?.classList.remove('open');
  document.getElementById('content').replaceChildren();
  document.getElementById('entryNotice').textContent='';
}
async function signOutFinance(){
  financeAuthEpoch++;financeSession=null;
  if(typeof closeQuickAdd==='function'){entryBusy=false;closeQuickAdd();}
  document.body.dataset.financeLocked='true';document.getElementById('app').hidden=true;
  document.getElementById('financeAuth').hidden=false;
  if(typeof disposePrivateReceipts==='function')disposePrivateReceipts();
  clearPrivateDeviceState();
  await _supabase.auth.signOut({scope:'local'});
  location.reload();
}
async function acceptFinanceSession(session){
  if(!session){financeSession=null;document.body.dataset.financeLocked='true';document.getElementById('app').hidden=true;document.getElementById('financeAuth').hidden=false;return;}
  if(financeBooting)return;
  const epoch=++financeAuthEpoch;financeBooting=true;
  const status=document.getElementById('financeAuthStatus');
  try{
    const {data:owner,error}=await _supabase.rpc('finance_is_owner');
    if(error)throw new Error('Private access is not ready yet. Please retry shortly.');
    if(!owner)throw new Error('This account does not have access to this dashboard.');
    financeSession=session;status.textContent='Loading your dashboard…';
    await loadFromSupabase();
    if(epoch!==financeAuthEpoch)return;
    document.getElementById('financeAuth').hidden=true;
    document.body.dataset.financeLocked='false';document.getElementById('app').hidden=false;
    document.getElementById('financeSignedInAs').textContent=session.user.email;
    restoreStateFromHash();render();
  }catch(error){financeSession=null;document.body.dataset.financeLocked='true';document.getElementById('app').hidden=true;document.getElementById('financeAuth').hidden=false;status.textContent=error.message;}
  finally{financeBooting=false;}
}
async function initFinanceAuth(){
  const {data:{session},error}=await _supabase.auth.getSession();
  if(error)document.getElementById('financeAuthStatus').textContent=error.message;
  await acceptFinanceSession(session);
  _supabase.auth.onAuthStateChange((event,session)=>{
    // Schedule outside the auth callback to avoid the Supabase auth lock.
    if(event==='SIGNED_OUT'){financeAuthEpoch++;disposePrivateReceipts();clearPrivateDeviceState();financeSession=null;document.body.dataset.financeLocked='true';document.getElementById('app').hidden=true;document.getElementById('financeAuth').hidden=false;}
    else if(event==='SIGNED_IN'&&!financeSession)setTimeout(()=>acceptFinanceSession(session),0);
    else if(event==='TOKEN_REFRESHED')financeSession=session;
  });
}
