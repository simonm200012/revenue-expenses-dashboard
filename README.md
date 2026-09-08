# Revenue & Expenses

Personal finance dashboard served by GitHub Pages, with transactions in Supabase and a daily Google Sheets import.

## Entry and receipt scanning

- **Add** opens manual entry. **Scan receipt** accepts JPG, PNG and WebP up to 12 MB; **Take photo** opens the device camera when supported. For a PDF or HEIC image, use a screenshot or convert to JPG first.
- Tesseract.js 6.0.1 runs OCR on the device in English and Slovenian. The first scan downloads the pinned OCR core and language models from jsDelivr; no receipt images are sent to an AI service or retained in the database.
- Review the photo, correct date, merchant, euro total, account and category, then confirm and save. Ambiguous totals, dates that cannot be read and non-euro amounts require manual input. OCR is a suggestion, never an automatic charge or transaction.
- **Transactions → Edit** corrects an existing entry. A matching amount and date produces a duplicate warning with a shortcut to edit the existing entry. Warnings are advisory, since multiple legitimate purchases can share a date and amount.
- New app entries use an `app:` row hash. A retry after a lost response uses the same token to avoid a second insert.

## Daily import

The existing Google Apps Script trigger runs `syncToSupabase` daily between **06:00 and 07:00 Europe/Ljubljana**. It runs in Google's infrastructure with the app and laptop closed. The existing daily failure notifications are retained.

`apps-script/Code.gs` is a credential-free copy of the deployed logic. A fresh installation needs `SUPABASE_KEY` and `SPREADSHEET_ID` in Script properties. The existing deployed project retains its private configuration; never commit its credential-bearing code. No OpenAI key is required.

The importer upserts Sheet rows, preserves app entries, re-applies imported-row corrections from `app_state` keys `txn-edit:<original row hash>`, uses a lock to prevent overlapping runs, and records status at `fin-sheets-sync`. It stops if corrections cannot be read. Failed batches throw so Apps Script can notify the owner. A running status older than ten minutes is shown as needing attention, including hard platform timeouts. Partial upserts are safe to retry; success is reported only after all batches succeed. The legacy destructive `fullReplaceSync` is disabled.

### Existing import limitations

The original hash includes the Sheet row position and transaction contents. This release preserves that identity scheme to avoid duplicating the existing database during deployment. **Do not sort, insert within, or edit previously imported Sheet rows** without a reviewed migration to persistent source IDs: such changes can produce a new hash and a duplicate. Make corrections in the app. The importer reads the `Data` tab; a separate `Cash payments` tab is included only if its contents feed into `Data`. App entries save directly to Supabase and do not write back into Sheets.

App corrections are stored before the corresponding transaction update. If that update fails, retry from the still-filled form. The correction remains visible to the app and is reapplied on the next import. The daily import reads corrections at the start of a run; an edit made during that same run is still shown by the app's correction layer and is reapplied to the underlying transaction on the following run. Editing the same entry from two devices currently uses last-write-wins.

## Recommended next changes

1. **Sign-in and owner-only database policies.** The current database allows anonymous reads and writes. Restricting access must be coordinated with the Sheets importer and existing GitHub workflows; the receipt feature does not change these permissions.
2. **Persistent import IDs.** Migrate existing rows once, then make Sheet reordering and upstream corrections safe.
3. **Private receipt archive and statement matching.** After sign-in is in place, retain receipts in private storage and attach them to imported bank entries, rather than counting one purchase twice.

## Development and checks

```sh
npm ci
npm test
npm run check
npm run dev
```

The app is static; GitHub Pages serves `index.html` and the existing assets directly. No framework build is required. The test suite exercises receipt amount/date parsing, save/edit/retry/duplicate flows using an in-memory Supabase adapter, and import failure/correction behavior using an Apps Script adapter. It does not create test transactions in the live database. A separate OCR smoke check on a synthetic Slovenian-format receipt recognized the merchant, date and €12.50 total correctly.

Vendored files in `vendor/tesseract` come from the unmodified `tesseract.js@6.0.1` npm distribution. Its Apache-2.0 license and bundled dependency notices are included. Bump the script query versions and service worker version whenever the entry scripts change so installed apps receive the update.
