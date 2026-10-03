// The deployed project retains its existing credential. For a fresh install,
// set SUPABASE_KEY in Apps Script > Project settings > Script properties.
const SUPABASE_URL = 'https://nirmwhvdoxujgzkhbhrk.supabase.co';
const SUPABASE_KEY = PropertiesService.getScriptProperties().getProperty('SUPABASE_KEY');
const FINANCE_WORKER_TOKEN = PropertiesService.getScriptProperties().getProperty('FINANCE_WORKER_TOKEN');
const TABLE_NAME = 'transactions';
const SHEET_NAME = 'Data';
const SPREADSHEET_ID = PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID');

// Recovery metadata contains counts and fingerprints only, never credentials or rows.
const SYNC_RUN_KEY = 'FINANCE_SYNC_RUN_V2';
const SYNC_SUCCESS_KEY = 'FINANCE_SYNC_LAST_SUCCESS';
const SYNC_MAX_ATTEMPTS = 3;
const SYNC_RECOVERY_MS = 8 * 60000;
const SYNC_WORK_MS = 220000;

function syncToSupabase() { runFinanceSync_(false); }
function financeSyncRecovery(event) { runFinanceSync_(true, event); }
function financeSyncRecoveryWake() { runFinanceSync_(true); }

function syncFailure_(message, retryable) {
  const error = new Error(message);
  error.financeSafe = true; error.retryable = !!retryable;
  return error;
}
function syncState_() {
  const text = PropertiesService.getScriptProperties().getProperty(SYNC_RUN_KEY);
  return text ? JSON.parse(text) : null;
}
function saveSyncState_(state) {
  state.updated_at = new Date().toISOString();
  PropertiesService.getScriptProperties().setProperty(SYNC_RUN_KEY, JSON.stringify(state));
}
function clearSyncRecovery_() {
  // This handler is exclusively a disposable recovery timer; daily/backup triggers stay intact.
  ScriptApp.getProjectTriggers().filter(t => ['financeSyncRecovery','financeSyncRecoveryWake'].includes(t.getHandlerFunction())).forEach(t => ScriptApp.deleteTrigger(t));
}
function armSyncRecovery_(state) {
  clearSyncRecovery_();
  state.recovery_trigger_id = null;
  let trigger;
  try { trigger = ScriptApp.newTrigger('financeSyncRecovery').timeBased().after(SYNC_RECOVERY_MS).create(); }
  catch (_) { throw syncFailure_('Could not schedule import recovery. Check Apps Script trigger permissions and quota.', false); }
  state.recovery_trigger_id = String(trigger.getUniqueId());
  state.next_retry_at = new Date(Date.now() + SYNC_RECOVERY_MS).toISOString();
  saveSyncState_(state);
}
function publicSyncState_(state) {
  // Checkpoint/fingerprint and trigger identifiers are internal bookkeeping.
  const value = Object.assign({}, state);
  delete value.fingerprint; delete value.recovery_trigger_id;
  delete value.status_pending; delete value.status_delivery_attempts;
  return value;
}
function publishSyncState_(state) {
  saveSyncState_(state);
  setSyncStatus(publicSyncState_(state));
}
function deliverFailedSync_(state) {
  // Row attempts are finished. Retry only this status if the service is unavailable.
  state.status_pending = true;
  state.status_delivery_attempts = (state.status_delivery_attempts || 0) + 1;
  saveSyncState_(state);
  try {
    setSyncStatus(publicSyncState_(state));
    state.status_pending = false; saveSyncState_(state); clearSyncRecovery_();
  } catch (error) {
    if (state.status_delivery_attempts >= SYNC_MAX_ATTEMPTS) {
      state.status_pending = false; saveSyncState_(state); clearSyncRecovery_();
    }
    throw error;
  }
}
function syncBudget_(state) {
  if (Date.now() - Date.parse(state.attempt_started_at) > SYNC_WORK_MS - 35000)
    throw syncFailure_('The import paused before its time limit. Saved progress will be retried.', true);
}
function syncFetch_(request, state, label, limit) {
  limit = limit || 3;
  request.timeoutSeconds = request.timeoutSeconds || 30;
  for (let attempt = 0; attempt < limit; attempt++) {
    if (state) syncBudget_(state);
    let response, error;
    try { response = UrlFetchApp.fetch(request.url, request); }
    catch (_) { error = syncFailure_(label + ': the connection timed out or was interrupted.', true); }
    if (response) {
      const code = response.getResponseCode();
      if (code >= 200 && code < 300) return response;
      error = syncFailure_(label + ' failed (HTTP ' + code + ').', code === 408 || code === 429 || code >= 500);
    }
    if (!error.retryable || attempt === limit - 1) throw error;
    Utilities.sleep((attempt + 1) * 2000);
  }
}
function runFinanceSync_(recovering, event) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) {
    // Never overwrite job state or delete timers without the lock. An unbound wake-up
    // revalidates the current job once the backup releases it; it cannot resume stale rows.
    const waiting = syncState_();
    if (recovering && waiting && (['running','retry_wait'].includes(waiting.status) || waiting.status_pending) &&
        (!event || String(event.triggerUid) === waiting.recovery_trigger_id) &&
        Date.now() - Date.parse(waiting.started_at) < 3600000) {
      ScriptApp.newTrigger('financeSyncRecoveryWake').timeBased().after(SYNC_RECOVERY_MS).create();
    }
    Logger.log('Another finance job is active. No rows were changed by this invocation.');
    return;
  }
  let state;
  try {
    const previous = syncState_();
    if (recovering) {
      ScriptApp.getProjectTriggers().filter(t => t.getHandlerFunction() === 'financeSyncRecoveryWake').forEach(t => ScriptApp.deleteTrigger(t));
      if (!previous || (!['running','retry_wait'].includes(previous.status) && !previous.status_pending) ||
          (event && String(event.triggerUid) !== previous.recovery_trigger_id)) return;
      state = previous;
      if (!event && Date.now() < Date.parse(state.next_retry_at || 0)) return;
      if (state.status === 'failed' && state.status_pending) {
        if (state.status_delivery_attempts >= SYNC_MAX_ATTEMPTS) {
          state.status_pending = false; saveSyncState_(state); clearSyncRecovery_();
          throw syncFailure_('Import failure status could not be delivered after three attempts. Check the execution log.', false);
        }
        armSyncRecovery_(state);
        state.next_retry_at = null; // No more row attempts are scheduled.
        deliverFailedSync_(state);
        return;
      }
      if (state.attempt >= SYNC_MAX_ATTEMPTS) {
        armSyncRecovery_(state); // Leave time to deliver a terminal status if the network is down.
        throw syncFailure_('The import was interrupted after three attempts. Check the execution log; the next daily run will try again.', false);
      }
    } else {
      state = { run_id: Utilities.getUuid(), started_at: new Date().toISOString(), attempt: 0,
        max_attempts: SYNC_MAX_ATTEMPTS, processed_rows: 0, row_count: 0,
        last_success_at: PropertiesService.getScriptProperties().getProperty(SYNC_SUCCESS_KEY) || null };
    }
    state.attempt++; state.attempt_started_at = new Date().toISOString();
    state.status = 'running'; state.stage = 'reading_sheet'; state.error = null; state.finished_at = null;
    // Set this before Sheets or network calls so even an uncatchable six-minute kill recovers.
    armSyncRecovery_(state);
    if (!FINANCE_WORKER_TOKEN || !SUPABASE_KEY || !SPREADSHEET_ID)
      throw syncFailure_('Missing sync configuration in Script properties. Check the project settings.', false);
    publishSyncState_(state);
    Logger.log('Sync attempt ' + state.attempt + ': reading the Data sheet.');
    const sheet = SpreadsheetApp.openById(SPREADSHEET_ID).getSheetByName(SHEET_NAME);
    if (!sheet) throw syncFailure_('Data sheet not found.', false);
    const values = sheet.getDataRange().getValues();
    syncBudget_(state);
    state.stage = 'loading_corrections'; publishSyncState_(state);
    const edits = loadAppCorrections(state);
    const rows = buildSyncRows(values, edits);
    if (!rows.length) throw syncFailure_('No valid rows found. Existing entries were preserved.', false);
    const fingerprint = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, JSON.stringify(rows))
      .map(b => ('0' + (b & 255).toString(16)).slice(-2)).join('');
    // A row offset is safe only for identical data, including saved app corrections.
    if (state.fingerprint !== fingerprint) { state.fingerprint = fingerprint; state.processed_rows = 0; }
    state.row_count = rows.length; state.stage = 'uploading'; publishSyncState_(state);
    for (let i = state.processed_rows; i < rows.length; i += 500) {
      syncBudget_(state);
      const batch = rows.slice(i, i + 500);
      Logger.log('Importing rows ' + (i + 1) + '–' + (i + batch.length) + ' of ' + rows.length + '.');
      syncFetch_(syncRequest('/rest/v1/' + TABLE_NAME + '?on_conflict=row_hash', 'post', batch), state, 'Import batch');
      state.processed_rows = i + batch.length;
      publishSyncState_(state);
    }
    state.stage = 'finishing'; saveSyncState_(state);
    const finished = new Date().toISOString();
    const success = Object.assign({}, state, { status: 'success', finished_at: finished,
      last_success_at: finished, next_retry_at: null, error: null,
      duration_ms: Date.now() - Date.parse(state.started_at) });
    // Keep local status running until the success write is acknowledged. A hard kill can replay it.
    setSyncStatus(publicSyncState_(success));
    state = success; saveSyncState_(state);
    PropertiesService.getScriptProperties().setProperty(SYNC_SUCCESS_KEY, finished);
    clearSyncRecovery_();
    Logger.log('Sync complete: ' + rows.length + ' rows. App entries and corrections preserved.');
  } catch (error) {
    if (!state) throw error;
    // Do not downgrade an acknowledged success, or restart completed row work when
    // a status-only recovery fails. Its delivery counter and timer are already saved.
    if (state.status === 'success' || (state.status === 'failed' && state.status_delivery_attempts)) throw error;
    const message = error.financeSafe ? error.message : 'Import stopped during ' + state.stage + '. Check the Apps Script execution log.';
    const retryable = error.financeSafe ? error.retryable : state.stage === 'reading_sheet';
    state.status = retryable && state.attempt < SYNC_MAX_ATTEMPTS ? 'retry_wait' : 'failed';
    state.error = message; state.finished_at = new Date().toISOString();
    if (state.status === 'failed') state.next_retry_at = null;
    else saveSyncState_(state);
    try {
      if (state.status === 'failed') deliverFailedSync_(state);
      else setSyncStatus(publicSyncState_(state));
    }
    catch (_) { Logger.log('Status could not be delivered; recovery state is saved locally.'); }
    throw error; // Keep Apps Script failure notifications working.
  } finally { lock.releaseLock(); }
}

function syncRequest(path, method, body) {
  const request = { url: SUPABASE_URL + path, method: method, headers: {
    apikey: SUPABASE_KEY, Authorization: 'Bearer ' + SUPABASE_KEY, 'x-finance-worker': FINANCE_WORKER_TOKEN,
    'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal'
  }, muteHttpExceptions: true };
  if (body !== undefined) request.payload = JSON.stringify(body);
  return request;
}

function setSyncStatus(value) {
  const request = syncRequest('/rest/v1/app_state?on_conflict=key', 'post', { key: 'fin-sheets-sync', value: value, updated_at: new Date().toISOString() });
  request.timeoutSeconds = 15;
  syncFetch_(request, null, 'Updating import status', 1);
}

function loadAppCorrections(state) {
  const edits = {};
  for (let offset = 0; ; offset += 1000) {
    const request = syncRequest('/rest/v1/app_state?select=key,value&key=like.txn-edit:*&order=key&limit=1000&offset=' + offset, 'get');
    const response = syncFetch_(request, state, 'Reading saved app corrections');
    const page = JSON.parse(response.getContentText());
    page.forEach(record => {
      const f = record.value && record.value.fields;
      if (!f || !/^\d{4}-\d{2}-\d{2}$/.test(f.date) || typeof f.value !== 'number' || !Number.isFinite(f.value) || f.value <= 0 || !['Inflow','Outflow','Investment'].includes(f.type) || typeof f.source !== 'string' || !f.source.trim()) throw syncFailure_('Invalid saved app correction; sync stopped for review.', false);
      const fields = { date: f.date, value: Math.round(f.value * 100) / 100, type: f.type };
      ['source','bank','category','final_category','cost_revenue_type'].forEach(key => { fields[key] = typeof f[key] === 'string' ? f[key].slice(0,500) : null; });
      edits[record.key.slice(9)] = fields;
    });
    if (page.length < 1000) break;
  }
  return edits;
}

function buildSyncRows(data, edits) {
  if (!data.length || String(data[0][0]).trim().toLowerCase() !== 'date' || data[0].length < 11) throw syncFailure_('Unexpected Data sheet layout. Import stopped.', false);
  const rows = [];
  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    if (!row[0] && !row[2]) continue;
    // Keep the original conversion and hash algorithm exactly, so deploying
    // this version matches existing rows instead of inserting a second copy.
    let value = row[2];
    if (typeof value === 'string') value = parseFloat(value.replace(/[€\s,]/g, '').replace('-', '0')) || 0;
    if (value === null || value === undefined) value = 0;
    if (!Number.isFinite(value)) throw syncFailure_('Invalid amount at sheet row ' + (i + 1), false);
    const date1 = formatDate(row[0]);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date1 || '')) throw syncFailure_('Invalid date at sheet row ' + (i + 1), false);
    const hashInput = [date1, value, row[3], row[4], row[5], row[6], row[7], i].join('|');
    const hash = Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, hashInput).map(b => ('0' + (b & 0xFF).toString(16)).slice(-2)).join('');
    const fields = {
      date: date1, date_2: formatDate(row[1]), value: value,
      source: row[3] || null, bank: row[4] || null, type: row[5] || null,
      cost_revenue_type: row[6] || null, category: row[7] || null,
      discount: row[8] || null, final_category: row[9] || null,
      found_in_statements: row[10] || null, row_hash: hash
    };
    rows.push(Object.assign(fields, edits[hash] || {}));
  }
  return rows;
}

function formatDate(value) {
  if (!value) return null;
  if (value instanceof Date) return Utilities.formatDate(value, 'Europe/Ljubljana', 'yyyy-MM-dd');
  return String(value);
}

function fullReplaceSync() {
  throw new Error('Full replace is disabled because it would delete app entries. Use syncToSupabase.');
}

function createDailyTrigger() {
  // The project already has its daily trigger. Do not create duplicates or
  // delete existing triggers (which would also lose notification settings).
  const existing = ScriptApp.getProjectTriggers().filter(t => t.getHandlerFunction() === 'syncToSupabase');
  if (existing.length) { Logger.log('Existing sync trigger retained.'); return; }
  ScriptApp.newTrigger('syncToSupabase').timeBased().atHour(6).everyDays(1).inTimezone('Europe/Ljubljana').create();
  Logger.log('Daily sync enabled: 06:00–07:00 Europe/Ljubljana.');
}


function createDailyBackupTrigger() {
  const existing = ScriptApp.getProjectTriggers().filter(t => t.getHandlerFunction() === 'backupFinanceDaily');
  if (existing.length) { Logger.log('Existing backup trigger retained.'); return; }
  ScriptApp.newTrigger('backupFinanceDaily').timeBased().atHour(5).everyDays(1).inTimezone('Europe/Ljubljana').create();
  Logger.log('Daily private backup enabled: 05:00–06:00 Europe/Ljubljana.');
}

function backupFinanceDaily() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) throw new Error('Another finance job is running. Retry the backup later.');
  try {
    if (!FINANCE_WORKER_TOKEN) throw new Error('Missing private finance worker token.');
    const request = syncRequest('/rest/v1/rpc/finance_export_snapshot', 'post', {});
    const response = UrlFetchApp.fetch(request.url, request);
    if (response.getResponseCode() !== 200) throw new Error('Could not read private snapshot (HTTP ' + response.getResponseCode() + ').');
    const text = response.getContentText(), payload = JSON.parse(text);
    if (!payload || !Array.isArray(payload.transactions) || payload.format_version !== 1) throw new Error('Snapshot was not authorized or was incomplete.');
    const gzip = Utilities.gzip(Utilities.newBlob(text, 'application/json', 'finance.json'), 'finance.json.gz');
    const bytes = gzip.getBytes();
    const checksum = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, bytes).map(b => ('0' + (b & 255).toString(16)).slice(-2)).join('');
    const path = 'daily/' + Utilities.formatDate(new Date(), 'Europe/Ljubljana', 'yyyy-MM-dd') + '-' + Utilities.getUuid() + '.json.gz';
    const upload = syncRequest('/storage/v1/object/finance-backups/' + path, 'post');
    upload.headers['Content-Type'] = 'application/gzip';upload.headers['Cache-Control'] = 'max-age=0';delete upload.headers.Prefer;upload.payload = bytes;
    const stored = UrlFetchApp.fetch(upload.url, upload);
    if (stored.getResponseCode() < 200 || stored.getResponseCode() >= 300) throw new Error('Private backup upload failed (HTTP ' + stored.getResponseCode() + ').');
    const record = syncRequest('/rest/v1/finance_backups', 'post', {storage_path:path,created_at:payload.created_at,row_count:payload.transactions.length,byte_count:bytes.length,sha256:checksum,source:'Daily Apps Script'});
    record.headers.Prefer = 'return=minimal';
    const saved = UrlFetchApp.fetch(record.url, record);
    if (saved.getResponseCode() < 200 || saved.getResponseCode() >= 300) throw new Error('Backup index could not be saved (HTTP ' + saved.getResponseCode() + ').');
    Logger.log('Private backup complete. Snapshot and checksum saved.');
  } finally { lock.releaseLock(); }
}
