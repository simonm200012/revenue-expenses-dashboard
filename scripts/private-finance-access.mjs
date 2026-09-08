const URL='https://nirmwhvdoxujgzkhbhrk.supabase.co';
const ANON='eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5pcm13aHZkb3h1amd6a2hiaHJrIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzUzNTA2MjksImV4cCI6MjA5MDkyNjYyOX0.XaYDMPW2hNjlzu31avolGZ2XebjjKs0yX1jFwSmPzB0';
export function privateFinanceRequest(path,options={}){
 const token=process.env.FINANCE_WORKER_TOKEN;
 if(!token)throw new Error('Missing FINANCE_WORKER_TOKEN.');
 return fetch(URL+path,{...options,headers:{apikey:ANON,Authorization:'Bearer '+ANON,'x-finance-worker':token,'Content-Type':'application/json',Prefer:'resolution=merge-duplicates,return=minimal',...options.headers}});
}
