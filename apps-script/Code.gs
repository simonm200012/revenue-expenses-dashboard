// The deployed project retains its existing credential. For a fresh install,
// set SUPABASE_KEY in Apps Script > Project settings > Script properties.
const SUPABASE_URL = 'https://nirmwhvdoxujgzkhbhrk.supabase.co';
const SUPABASE_KEY = PropertiesService.getScriptProperties().getProperty('SUPABASE_KEY');
const TABLE_NAME = 'transactions';
const SHEET_NAME = 'Data';
const SPREADSHEET_ID = PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID');

function syncToSupabase() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) throw new Error('Another sync is running. This run did not change any rows.');
  const startedAt = new Date().toISOString();
  try {
    if (!SUPABASE_KEY) throw new Error('Missing Supabase credential in Script properties.');
    setSyncStatus({ status: 'running', started_at: startedAt });
    // Explicit ID works from a scheduled execution without an open spreadsheet.
    const sheet = SpreadsheetApp.openById(SPREADSHEET_ID).getSheetByName(SHEET_NAME);
    if (!sheet) throw new Error('Data sheet not found.');
    const edits = loadAppCorrections();
    const rows = buildSyncRows(sheet.getDataRange().getValues(), edits);
    if (!rows.length) throw new Error('No valid rows found. Existing database entries were preserved.');
    let count = 0;
    // Limit concurrency while avoiding six sequential network waits for a full import.
    const batches = [];
    for (let i = 0; i < rows.length; i += 500) batches.push(rows.slice(i, i + 500));
    for (let i = 0; i < batches.length; i += 3) {
      if (Date.now() - Date.parse(startedAt) > 270000) throw new Error('Sync approaching time limit; remaining rows will retry on the next daily run.');
      const group = batches.slice(i, i + 3);
      const requests = group.map(batch => syncRequest('/rest/v1/' + TABLE_NAME + '?on_conflict=row_hash', 'post', batch));
      const responses = UrlFetchApp.fetchAll(requests);
      responses.forEach((response, index) => {
        const code = response.getResponseCode();
        if (code < 200 || code >= 300) throw new Error('Import batch failed (HTTP ' + code + '). Existing entries were preserved; retry is safe.');
        count += group[index].length;
      });
    }
    setSyncStatus({ status: 'success', started_at: startedAt, finished_at: new Date().toISOString(), row_count: count });
    Logger.log('Sync complete: ' + count + ' rows. App entries and corrections preserved.');
  } catch (error) {
    try { setSyncStatus({ status: 'failed', started_at: startedAt, finished_at: new Date().toISOString() }); } catch (_) {}
    // Throw so the existing daily failure notification actually reports API failures.
    throw error;
  } finally {
    lock.releaseLock();
  }
}

function syncRequest(path, method, body) {
  const request = { url: SUPABASE_URL + path, method: method, headers: {
    apikey: SUPABASE_KEY, Authorization: 'Bearer ' + SUPABASE_KEY,
    'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal'
  }, muteHttpExceptions: true };
  if (body !== undefined) request.payload = JSON.stringify(body);
  return request;
}

function setSyncStatus(value) {
  const request = syncRequest('/rest/v1/app_state?on_conflict=key', 'post', { key: 'fin-sheets-sync', value: value, updated_at: new Date().toISOString() });
  const response = UrlFetchApp.fetch(request.url, request);
  if (response.getResponseCode() < 200 || response.getResponseCode() >= 300) throw new Error('Could not update import status. Check app_state permissions.');
}

function loadAppCorrections() {
  const edits = {};
  for (let offset = 0; ; offset += 1000) {
    const request = syncRequest('/rest/v1/app_state?select=key,value&key=like.txn-edit:*&order=key&limit=1000&offset=' + offset, 'get');
    const response = UrlFetchApp.fetch(request.url, request);
    if (response.getResponseCode() !== 200) throw new Error('Cannot read app corrections. Sync stopped to protect them.');
    const page = JSON.parse(response.getContentText());
    page.forEach(record => {
      const f = record.value && record.value.fields;
      if (!f || !/^\d{4}-\d{2}-\d{2}$/.test(f.date) || typeof f.value !== 'number' || !Number.isFinite(f.value) || f.value <= 0 || !['Inflow','Outflow','Investment'].includes(f.type) || typeof f.source !== 'string' || !f.source.trim()) throw new Error('Invalid saved app correction; sync stopped for review.');
      const fields = { date: f.date, value: Math.round(f.value * 100) / 100, type: f.type };
      ['source','bank','category','final_category','cost_revenue_type'].forEach(key => { fields[key] = typeof f[key] === 'string' ? f[key].slice(0,500) : null; });
      edits[record.key.slice(9)] = fields;
    });
    if (page.length < 1000) break;
  }
  return edits;
}

function buildSyncRows(data, edits) {
  if (!data.length || String(data[0][0]).trim().toLowerCase() !== 'date' || data[0].length < 11) throw new Error('Unexpected Data sheet layout. Import stopped.');
  const rows = [];
  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    if (!row[0] && !row[2]) continue;
    // Keep the original conversion and hash algorithm exactly, so deploying
    // this version matches existing rows instead of inserting a second copy.
    let value = row[2];
    if (typeof value === 'string') value = parseFloat(value.replace(/[€\s,]/g, '').replace('-', '0')) || 0;
    if (value === null || value === undefined) value = 0;
    if (!Number.isFinite(value)) throw new Error('Invalid amount at sheet row ' + (i + 1));
    const date1 = formatDate(row[0]);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date1 || '')) throw new Error('Invalid date at sheet row ' + (i + 1));
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
