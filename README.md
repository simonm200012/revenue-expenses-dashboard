# Revenue & Expenses

Private personal finance dashboard on GitHub Pages, with Supabase storage and a daily Google Sheets import.

## Sign-in and private access

Sign in using the email code sent to the owner address configured in `finance_private.settings`. Ownership is checked against a confirmed Supabase Auth email on the server. Database policies, transaction RPCs and private storage policies enforce access; the login screen alone is not the security boundary.

Transactions are edited through atomic RPCs. The public API identifier in the source does not grant access to financial data. Scheduled jobs use separate private random tokens, stored in Apps Script properties and GitHub Actions secrets; only their SHA-256 hashes and allowed scopes are stored in `finance_private.worker_tokens`.

- Apps Script: import transactions, read consistent backup snapshots, upload backup files and index them. It cannot download receipt or backup files or change app-created entries.
- GitHub Actions: read transactions for the existing weekly summary and update the private Trading 212 portfolio.
- Signed-in owner: dashboard data, entry editing, receipt archive, history, Trash and backup downloads.

Portfolio updates now go to private `app_state` under `fin-t212-portfolio`. Do not reintroduce a public portfolio JSON file. Historical portfolio files remain in Git history; this release does not rewrite repository history or revoke copies previously downloaded while the dashboard was public.

## Entries and receipts

**Add** opens a manual entry. **Upload receipts** in the Review inbox accepts up to 20 JPG, PNG, WebP or PDF files per batch, 20 MB per file and 50 pages per PDF. Convert HEIC photos to JPG before uploading.

Original files are saved in the private `finance-receipts` bucket. Each PDF page becomes a separate pending review item before scanning starts, so leaving the page preserves the queue. File hashes prevent repeat uploads from creating another queue item. Tesseract.js 6.0.1 reads English and Slovenian on the device; PDF.js 5.4.624 reads text PDFs and renders scanned pages for OCR. OCR core and language downloads use jsDelivr. Receipt contents are not sent to an AI API.

Review the date, merchant, euro total, account and category before confirming. Ambiguous or non-euro amounts need manual input. You can either save a new expense or **Attach** the receipt to an existing transaction. Suggested matches use the same amount within three days; a search finds other transactions. Attachment leaves spending totals unchanged. Archived queue items can be reopened, and linked receipts can be viewed from the transaction editor.

The Review inbox also lists uncategorized expenses and possible duplicate groups. Duplicate warnings are advisory: separate purchases may have the same date and amount. Nothing is removed automatically.

## Corrections, history and Trash

**Transactions → Edit** changes an existing entry. Updates include a server version check; a newer edit on another device must be reloaded before saving. Stable `app:` save tokens make retries safe after a lost response. Receipt linking and entry creation happen in one database transaction.

Saved changes offer **Undo**. **History** shows before/after values and can restore the version before an earlier change. **Move to Trash** excludes an entry from all totals without deleting its history or receipt. The Trash tab restores it. Sheets imports preserve both corrections and Trash state in database triggers, including an app edit made while an import is running. History begins when this upgrade is enabled; a private pre-upgrade snapshot preserves earlier state.

## Daily import and backups

Both jobs run on Google's infrastructure with the laptop and dashboard closed:

- `backupFinanceDaily`: **05:00–06:00 Europe/Ljubljana**, private backup snapshot.
- `syncToSupabase`: **06:00–07:00 Europe/Ljubljana**, existing Sheets import.

`apps-script/Code.gs` contains no private credentials. Its Script properties are `SUPABASE_KEY`, `SPREADSHEET_ID` and `FINANCE_WORKER_TOKEN`. Trigger setup functions retain existing triggers rather than duplicating them. Failed jobs throw errors for Apps Script's failure notifications.

Backups capture transactions (including Trash), app settings, receipt metadata and history in one consistent database snapshot. Gzip files and their SHA-256 checksums are stored privately. **Back up now** creates an additional snapshot; **Download JSON** verifies the checksum and downloads readable recovery data. Originals remain in the private receipt bucket and can be downloaded individually. Snapshots are retained; no automatic deletion is scheduled. Recovery of an entire database is a deliberate administrator operation, while individual transaction recovery is available in the app.

The backup worker only uploads storage objects. Downloads use the owner's Auth JWT; custom worker headers must not authorize Storage downloads because CDN caches are keyed on JWT identity. Browser uploads and backup uploads use a zero cache lifetime.

### Existing Sheet identity limitation

The original import hash includes the Sheet row position and mutable transaction fields. It is preserved to match existing records. Sorting, inserting within or editing already-imported Sheet rows can create duplicates. Make corrections in the app. A future migration to persistent Sheet IDs is needed before changing old Sheet rows freely.

The importer reads the `Data` tab. `Cash payments` is included only if its contents feed into `Data`. App entries save directly to Supabase and do not write back into Sheets. Partial batch failures are safe to retry; destructive full replacement is disabled.

## Deployment and development

```sh
npm ci
npm test
npm run check
npm run dev
```

GitHub Pages serves the static files without a framework build. The migrations are staged: `001_private_workflows.sql` creates private tables, RPCs and storage; configure the owner and worker hashes privately, set the scheduled-job secrets and deploy their updated code; then apply `002_restrict_existing_access.sql` to remove the original public transaction/state policies. `003_owner_only_backup_downloads.sql` removes the temporary worker download policy if an earlier staging version was installed. Do not publish setup files, plaintext worker tokens or owner sessions.

Tests cover PostgreSQL RLS and RPC behavior with PGlite, manual save/edit/retry flows, safe receipt matching, multi-file queue persistence, actual multi-page PDF extraction, HTML escaping, and Apps Script import/backup failure handling. Fixtures are synthetic and do not insert test transactions into the live database.

Vendored OCR and PDF libraries retain their upstream Apache-2.0 licenses. PDF CMaps, fonts and WASM support assets are included. Bump the asset query versions and service-worker version when publishing changes so installed apps receive them.
