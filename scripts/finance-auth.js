// Supabase validates identity; database and storage policies enforce ownership.
const FINANCE_USERNAME='simon',FINANCE_OWNER_EMAIL='simonm2000@outlook.com';
let financeSession=null,financeBooting=false,financeAuthEpoch=0,financeAuthSubscribed=false,financeSigningIn=false;
async function signInFinance(event){
  event?.preventDefault();
  const username=document.getElementById('financeUsername').value.trim().toLowerCase();
  const passwordInput=document.getElementById('financePassword');
  const status=document.getElementById('financeAuthStatus'),button=document.getElementById('financeSignIn');
  if(financeSigningIn)return;
  if(username!==FINANCE_USERNAME||!passwordInput.value){passwordInput.value='';status.textContent='Check your username and password and try again.';return;}
  financeSigningIn=true;button.disabled=true;status.textContent='Signing in…';
  try{
    // The username is an alias, never an access check. Supabase validates the password.
    const request=_supabase.auth.signInWithPassword({email:FINANCE_OWNER_EMAIL,password:passwordInput.value});
    passwordInput.value='';
    const {data,error}=await request;
    if(error)throw error;
    if(!data?.session)throw new Error('No session returned');
    await acceptFinanceSession(data.session);
  }catch(error){status.textContent=error.code==='invalid_credentials'?'Check your username and password and try again.':'Could not sign in. Check your connection and try again.';}
  finally{passwordInput.value='';financeSigningIn=false;button.disabled=false;}
}
function openFinancePassword(){
  if(!financeSession)return;
  document.getElementById('financePasswordForm').reset();
  document.getElementById('financePasswordStatus').textContent='';
  document.getElementById('financePasswordDialog').showModal();
}
function clearFinancePasswords(){
  document.getElementById('financePassword').value='';
  document.getElementById('financePasswordForm').reset();
}
async function saveFinancePassword(event){
  event?.preventDefault();
  const button=document.getElementById('financeSavePassword'),status=document.getElementById('financePasswordStatus');
  const password=document.getElementById('financeNewPassword'),confirmation=document.getElementById('financeConfirmPassword');
  if(button.disabled)return;
  if(!financeSession){clearFinancePasswords();status.textContent='Sign in before setting a password.';return;}
  if(password.value.length<8){status.textContent='Use at least 8 characters.';return;}
  if(password.value!==confirmation.value){status.textContent='The passwords do not match.';return;}
  button.disabled=true;status.textContent='Saving your password…';
  try{
    const request=_supabase.auth.updateUser({password:password.value});
    clearFinancePasswords();
    const {error}=await request;
    if(error)throw error;
    status.textContent='Password saved. Next time, sign in with username simon and your password.';
  }catch(error){status.textContent=error.code==='weak_password'?'Choose a stronger password and try again.':error.code==='same_password'?'This is already your current password.':'Could not save your password. Check your connection and sign-in session, then try again.';}
  finally{clearFinancePasswords();button.disabled=false;}
}
function clearPrivateDeviceState(){
  clearFinancePasswords();
  const passwordDialog=document.getElementById('financePasswordDialog');
  if(passwordDialog.open)passwordDialog.close();
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
    if(epoch!==financeAuthEpoch)return;
    financeSession=session;status.textContent='Loading your dashboard…';
    await loadFromSupabase();
    if(epoch!==financeAuthEpoch)return;
    document.getElementById('financeAuth').hidden=true;
    document.body.dataset.financeLocked='false';document.getElementById('app').hidden=false;
    document.getElementById('financeSignedInAs').textContent=FINANCE_USERNAME;
    restoreStateFromHash();render();
  }catch(error){financeSession=null;document.body.dataset.financeLocked='true';document.getElementById('app').hidden=true;document.getElementById('financeAuth').hidden=false;status.textContent=error.message;}
  finally{financeBooting=false;}
}
async function initFinanceAuth(){
  const {data:{session},error}=await _supabase.auth.getSession();
  if(error)document.getElementById('financeAuthStatus').textContent=error.message;
  await acceptFinanceSession(session);
  if(financeAuthSubscribed)return;
  financeAuthSubscribed=true;
  _supabase.auth.onAuthStateChange((event,session)=>{
    // Schedule outside the auth callback to avoid the Supabase auth lock.
    if(event==='SIGNED_OUT'){financeAuthEpoch++;disposePrivateReceipts();clearPrivateDeviceState();financeSession=null;document.body.dataset.financeLocked='true';document.getElementById('app').hidden=true;document.getElementById('financeAuth').hidden=false;}
    else if(event==='SIGNED_IN'&&!financeSession&&!financeSigningIn)setTimeout(()=>acceptFinanceSession(session),0);
    else if(event==='TOKEN_REFRESHED')financeSession=session;
  });
}
