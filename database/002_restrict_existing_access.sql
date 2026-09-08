-- Apply after private tokens are configured and the sign-in UI is published.
begin;
-- Finish any correction saved by the previous two-request edit implementation.
update public.transactions t set date=(s.value->'fields'->>'date')::date,value=(s.value->'fields'->>'value')::numeric,
 source=s.value->'fields'->>'source',bank=s.value->'fields'->>'bank',type=s.value->'fields'->>'type',
 category=s.value->'fields'->>'category',final_category=s.value->'fields'->>'final_category',cost_revenue_type=s.value->'fields'->>'cost_revenue_type'
from public.app_state s where s.key='txn-edit:'||t.row_hash and jsonb_typeof(s.value->'fields')='object';
do $$declare p record;begin
 for p in select tablename,policyname from pg_policies where schemaname='public' and tablename in ('transactions','app_state') loop
  execute format('drop policy %I on public.%I',p.policyname,p.tablename);
 end loop;
end $$;
alter table public.transactions enable row level security;
alter table public.app_state enable row level security;
create policy finance_transactions_owner on public.transactions for select to authenticated using(public.finance_is_owner());
create policy finance_transactions_import_read on public.transactions for select to anon using(public.finance_worker_scope('import') or public.finance_worker_scope('report') or public.finance_worker_scope('backup'));
create policy finance_transactions_import_insert on public.transactions for insert to anon with check(public.finance_worker_scope('import') and row_hash not like 'app:%');
create policy finance_transactions_import_update on public.transactions for update to anon using(public.finance_worker_scope('import') and row_hash not like 'app:%') with check(public.finance_worker_scope('import') and row_hash not like 'app:%');
create policy finance_state_owner on public.app_state for all to authenticated using(public.finance_is_owner()) with check(public.finance_is_owner());
create policy finance_state_worker_read on public.app_state for select to anon using(public.finance_worker_scope('import') or public.finance_worker_scope('backup') or (key='fin-t212-portfolio' and public.finance_worker_scope('portfolio')));
create policy finance_state_worker_insert on public.app_state for insert to anon with check((key in ('fin-sheets-sync','fin-backup-status') and (public.finance_worker_scope('import') or public.finance_worker_scope('backup'))) or (key='fin-t212-portfolio' and public.finance_worker_scope('portfolio')));
create policy finance_state_worker_update on public.app_state for update to anon using((key in ('fin-sheets-sync','fin-backup-status') and (public.finance_worker_scope('import') or public.finance_worker_scope('backup'))) or (key='fin-t212-portfolio' and public.finance_worker_scope('portfolio'))) with check((key in ('fin-sheets-sync','fin-backup-status') and (public.finance_worker_scope('import') or public.finance_worker_scope('backup'))) or (key='fin-t212-portfolio' and public.finance_worker_scope('portfolio')));
revoke all on public.transactions,public.app_state from public,anon,authenticated;
grant select on public.transactions to authenticated;
grant select,insert,update on public.transactions to anon;
grant select,insert,update on public.app_state to anon,authenticated;
-- Existing identity sequence usage is needed by the restricted importer.
do $$declare seq text;begin
 seq=pg_get_serial_sequence('public.transactions','id');
 if seq is not null then execute format('grant usage on sequence %s to anon',seq);end if;
end $$;
commit;
