/* Read-only presentation of the Sheets worker's saved status. */
(function(root){
  'use strict';
  const STALLED_MS=10*60*1000,OVERDUE_MS=36*60*60*1000;
  function timestamp(value){
    if(typeof value!=='string')return null;
    const m=value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/);
    if(!m||+m[2]<1||+m[2]>12||+m[3]<1||+m[3]>new Date(Date.UTC(+m[1],+m[2],0)).getUTCDate()||+m[4]>23||+m[5]>59||+m[6]>59)return null;
    const n=Date.parse(value);return Number.isFinite(n)?n:null;
  }
  function count(value){return typeof value==='number'&&Number.isSafeInteger(value)&&value>=0&&value<=1000000000?value:null;}
  function describe(value,options={}){
    const sl=options.lang==='sl',t=(en,si)=>sl?si:en,locale=sl?'sl-SI':'en-GB';
    const now=Number.isFinite(options.now)?options.now:Date.now();
    const s=value&&typeof value==='object'&&!Array.isArray(value)?value:{};
    const format=n=>n===null?'':new Date(n).toLocaleString(locale,{dateStyle:'short',timeStyle:'short',timeZone:'Europe/Ljubljana'});
    const number=n=>n.toLocaleString(locale);
    const started=timestamp(s.started_at),finished=timestamp(s.finished_at),attemptStarted=timestamp(s.attempt_started_at),heartbeat=timestamp(s.updated_at);
    const lastSuccess=timestamp(s.last_success_at)??(s.status==='success'?(finished??started):null);
    const activeAt=heartbeat??attemptStarted??started,nextRetry=timestamp(s.next_retry_at);
    const total=count(s.row_count),processed=count(s.processed_rows),attempt=count(s.attempt),max=count(s.max_attempts);
    const rows=[];
    const add=(label,data)=>{if(data!==null&&data!==undefined&&data!=='')rows.push({label,value:String(data)});};
    const addTime=(en,si,n)=>{if(n!==null)add(t(en,si),format(n));};
    let state='unknown',tone='muted',title=t('Sheets import: awaiting status','Uvoz preglednice: čakam stanje'),message=t('No import status has been recorded yet.','Stanje uvoza še ni zabeleženo.');
    if(options.unavailable){
      state='unavailable';tone='warning';title=t('Sheets sync status unavailable','Stanje uvoza preglednice ni na voljo');
      message=t('Could not check the latest status. Refresh the status when your connection is available.','Najnovejšega stanja ni bilo mogoče preveriti. Ko bo povezava na voljo, osvežite stanje.');
    }else if(s.status==='success'){
      state=lastSuccess===null?'success_unknown_time':now-lastSuccess>OVERDUE_MS?'overdue':'success';
      tone=state==='success'?'muted':'warning';
      title=state==='overdue'?t('Sheets import overdue','Uvoz preglednice zamuja'):t('Sheets synced','Preglednica posodobljena');
      if(lastSuccess!==null)title+=' · '+format(lastSuccess);
      message=state==='overdue'?t('The last completed import is over 36 hours old. Check the execution log for a missed or interrupted run.','Zadnji uspešni uvoz je starejši od 36 ur. V dnevniku izvajanj preverite, ali se je uvoz začel in dokončal.'):
        state==='success_unknown_time'?t('The worker reported success, but did not provide a valid completion time.','Opravilo je sporočilo uspeh, vendar ni podalo veljavnega časa zaključka.'):
        t('The latest Sheets import completed successfully.','Zadnji uvoz iz preglednice je bil uspešno dokončan.');
    }else if(s.status==='running'){
      state=activeAt===null?'running_unknown_time':now-activeAt>STALLED_MS?'stalled':'running';tone=state==='running'?'muted':'warning';
      title=state==='stalled'?t('Sheets import stopped reporting progress','Uvoz preglednice ne sporoča več napredka'):state==='running_unknown_time'?t('Sheets import status needs checking','Preverite stanje uvoza preglednice'):t('Sheets import running…','Uvoz preglednice poteka…');
      message=state==='stalled'?t('No progress update for over 10 minutes. The job may have ended before reporting completion; the execution log can show why.','Več kot 10 minut ni bilo sporočila o napredku. Opravilo se je morda končalo brez potrditve zaključka; razlog preverite v dnevniku izvajanj.'):
        state==='running_unknown_time'?t('The saved status says running, but has no valid progress timestamp. Check the execution log.','Shranjeno stanje pravi, da uvoz poteka, vendar nima veljavnega časa napredka. Preverite dnevnik izvajanj.'):
        t('The daily import is in progress. Refresh the status to see the latest update.','Dnevni uvoz poteka. Za najnovejše podatke osvežite stanje.');
    }else if(s.status==='retry_wait'){
      state=nextRetry===null?'retry_unknown_time':now>nextRetry+2*60*1000?'retry_overdue':now>=nextRetry?'retry_due':'retry_scheduled';tone='warning';
      title=state==='retry_scheduled'?t('Sheets retry scheduled','Ponovni uvoz preglednice je načrtovan'):state==='retry_overdue'?t('Sheets retry is overdue','Ponovni uvoz preglednice zamuja'):state==='retry_due'?t('Waiting for Sheets retry','Čakam ponovni uvoz preglednice'):t('Sheets retry time unavailable','Čas ponovnega uvoza ni na voljo');
      if(nextRetry!==null)title+=' · '+format(nextRetry);
      message=state==='retry_scheduled'?t('The previous attempt did not finish. Another attempt is scheduled automatically.','Prejšnji poskus se ni dokončal. Nov poskus je samodejno načrtovan.'):
        state==='retry_overdue'?t('The scheduled retry time has passed without a new progress update. Refresh the status or check the execution log.','Načrtovani čas ponovnega uvoza je minil brez novega sporočila o napredku. Osvežite stanje ali preverite dnevnik izvajanj.'):
        state==='retry_due'?t('The next attempt is due now. Refresh the status shortly to check whether it started.','Čas je za naslednji poskus. Kmalu osvežite stanje in preverite, ali se je začel.'):
        t('A retry was requested, but no valid scheduled time was recorded. Check the execution log.','Ponovni poskus je bil zahtevan, vendar veljaven čas ni zabeležen. Preverite dnevnik izvajanj.');
    }else if(s.status==='failed'){
      state='failed';tone='warning';title=t('Sheets import failed','Uvoz preglednice ni uspel');
      message=t('The import reported an error. Check the details below and open the execution log to investigate.','Uvoz je sporočil napako. Preverite spodnje podrobnosti in odprite dnevnik izvajanj.');
    }else if(s.status){
      state='unknown';tone='warning';title=t('Sheets import status not recognized','Stanje uvoza preglednice ni prepoznano');message=t('Refresh the status or check the execution log.','Osvežite stanje ali preverite dnevnik izvajanj.');
    }
    // A failed status fetch must not present a cached success as a fresh check.
    if(!options.unavailable){
      addTime('Last successful import','Zadnji uspešni uvoz',lastSuccess);
      addTime('Import started','Začetek uvoza',started);
      if(attemptStarted!==started)addTime('Current attempt started','Začetek trenutnega poskusa',attemptStarted);
      addTime('Last progress update','Zadnje sporočilo o napredku',heartbeat);
      if(s.status!=='success')addTime('Attempt finished','Zaključek poskusa',finished);
      const stages={reading_sheet:t('Reading the Sheet','Branje preglednice'),loading_corrections:t('Loading saved corrections','Nalaganje shranjenih popravkov'),uploading:t('Saving imported rows','Shranjevanje uvoženih vrstic'),finishing:t('Finishing the import','Zaključevanje uvoza')};
      if(s.status==='running'||s.status==='retry_wait')add(t('Stage','Korak'),stages[s.stage]);
      if(total!==null&&processed!==null&&s.status!=='success')add(t('Rows processed','Obdelane vrstice'),`${number(processed)} / ${number(total)}`);
      else if(s.status==='success'&&total!==null)add(t('Rows synced','Posodobljene vrstice'),number(total));
      else if(processed!==null)add(t('Rows processed','Obdelane vrstice'),number(processed));
      else if(total!==null)add(t('Rows in this import','Vrstice v tem uvozu'),number(total));
      if(attempt!==null&&attempt>0)add(t('Attempt','Poskus'),max!==null&&max>=attempt?`${attempt} / ${max}`:attempt);
      if(s.status==='retry_wait')addTime('Next retry','Naslednji poskus',nextRetry);
      if(typeof s.error==='string'&&s.error.trim())add(t('Reported error','Sporočena napaka'),s.error.replace(/[\u0000-\u001f\u007f]/g,' ').trim().slice(0,500));
    }
    return {state,tone,title,message,rows,detailsLabel:t('Sync details','Podrobnosti uvoza'),refreshLabel:t('Refresh status','Osveži stanje'),checkingLabel:t('Checking…','Preverjam…'),logLabel:t('Open execution log','Odpri dnevnik izvajanj'),schedule:t('Daily, 06:00–07:00 Europe/Ljubljana. Times shown in Ljubljana time.','Dnevno, 6.00–7.00 Europe/Ljubljana. Prikazani so ljubljanski časi.'),reassurance:t('App entries save immediately; this status only describes the Sheets import.','Vnosi v aplikaciji se shranijo takoj; to stanje velja le za uvoz preglednice.')};
  }
  const api={describe,timestamp};if(typeof module!=='undefined'&&module.exports)module.exports=api;else root.SheetsSyncStatus=api;
})(typeof window!=='undefined'?window:globalThis);
