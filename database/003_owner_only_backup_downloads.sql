begin;
drop policy if exists finance_backups_worker_file_read on storage.objects;
commit;
