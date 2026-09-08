begin;
create schema if not exists finance_private;
revoke all on schema finance_private from public,anon,authenticated;
create table if not exists finance_private.settings(singleton boolean primary key default true check(singleton),owner_email text not null);
create table if not exists finance_private.worker_tokens(name text primary key,token_hash text not null,scopes text[] not null);
create table if not exists finance_private.preupgrade_snapshots(created_at timestamptz default now(),payload jsonb not null);
insert into finance_private.preupgrade_snapshots(payload)
select jsonb_build_object('transactions',(select coalesce(jsonb_agg(t),'[]') from public.transactions t),'app_state',(select coalesce(jsonb_agg(s),'[]') from public.app_state s))
where not exists(select 1 from finance_private.preupgrade_snapshots);

create or replace function public.finance_is_owner() returns boolean
language sql stable security definer set search_path='' as $$
 select exists(select 1 from auth.users u cross join finance_private.settings s
 where u.id=auth.uid() and u.email_confirmed_at is not null and lower(u.email)=lower(s.owner_email));
$$;
create or replace function public.finance_worker_scope(scope_name text) returns boolean
language sql stable security definer set search_path='' as $$
 select exists(select 1 from finance_private.worker_tokens t where scope_name=any(t.scopes)
 and t.token_hash=encode(sha256(convert_to(coalesce(nullif(current_setting('request.headers',true),'')::jsonb->>'x-finance-worker',''),'UTF8')),'hex'));
$$;
revoke all on function public.finance_is_owner(),public.finance_worker_scope(text) from public;
grant execute on function public.finance_is_owner() to authenticated;
grant execute on function public.finance_worker_scope(text) to anon,authenticated;

alter table public.transactions add column if not exists deleted_at timestamptz;
alter table public.transactions add column if not exists updated_at timestamptz not null default now();
create table if not exists public.finance_receipts(
 id uuid primary key default gen_random_uuid(),storage_path text not null,original_name text not null,
 mime_type text not null check(mime_type in ('image/jpeg','image/png','image/webp','application/pdf')),
 file_hash text not null check(file_hash ~ '^[a-f0-9]{64}$'),page_number integer not null default 1 check(page_number between 1 and 50),
 status text not null default 'pending' check(status in ('pending','linked','dismissed')),
 extracted jsonb not null default '{}',transaction_id bigint references public.transactions(id),
 created_at timestamptz not null default now(),updated_at timestamptz not null default now(),
 unique(file_hash,page_number),check((status='linked')=(transaction_id is not null))
);
create index if not exists finance_receipts_transaction_idx on public.finance_receipts(transaction_id);
create table if not exists public.finance_history(
 id bigint generated always as identity primary key,transaction_id bigint not null,
 action text not null,actor text not null,old_record jsonb,new_record jsonb,created_at timestamptz not null default now()
);
create index if not exists finance_history_transaction_idx on public.finance_history(transaction_id,id desc);
create table if not exists public.finance_backups(
 id uuid primary key default gen_random_uuid(),storage_path text unique not null,created_at timestamptz not null default now(),
 row_count integer not null check(row_count>=0),byte_count integer not null check(byte_count>0),sha256 text not null,
 format_version integer not null default 1,source text not null default 'app'
);

create or replace function finance_private.prepare_transaction() returns trigger
language plpgsql security definer set search_path='' as $$
declare correction jsonb;
begin
 if public.finance_worker_scope('import') and new.row_hash is not null then
  select value->'fields' into correction from public.app_state where key='txn-edit:'||new.row_hash;
  if correction is not null then
   new.date=(correction->>'date')::date; new.value=(correction->>'value')::numeric;new.source=correction->>'source';
   new.bank=correction->>'bank';new.type=correction->>'type';new.category=correction->>'category';
   new.final_category=correction->>'final_category';new.cost_revenue_type=correction->>'cost_revenue_type';
  end if;
  if tg_op='UPDATE' then new.deleted_at=old.deleted_at;end if;
 end if;
 if tg_op='INSERT' or (to_jsonb(new)-'updated_at') is distinct from (to_jsonb(old)-'updated_at') then new.updated_at=clock_timestamp();
 else new.updated_at=old.updated_at;end if;
 return new;
end $$;
create or replace function finance_private.audit_transaction() returns trigger
language plpgsql security definer set search_path='' as $$
declare a text;who text;
begin
 if tg_op='UPDATE' and (to_jsonb(new)-'updated_at') is not distinct from (to_jsonb(old)-'updated_at') then return new;end if;
 who=case when public.finance_worker_scope('import') then 'Sheets import' when auth.uid() is not null then 'You' else 'Maintenance' end;
 a=case when tg_op='INSERT' then 'created' when old.deleted_at is null and new.deleted_at is not null then 'trashed' when old.deleted_at is not null and new.deleted_at is null then 'restored' else 'edited' end;
 insert into public.finance_history(transaction_id,action,actor,old_record,new_record) values(new.id,a,who,case when tg_op='UPDATE' then to_jsonb(old) else null end,to_jsonb(new));
 return new;
end $$;
drop trigger if exists finance_prepare_transaction on public.transactions;
create trigger finance_prepare_transaction before insert or update on public.transactions for each row execute function finance_private.prepare_transaction();
drop trigger if exists finance_audit_transaction on public.transactions;
create trigger finance_audit_transaction after insert or update on public.transactions for each row execute function finance_private.audit_transaction();

create or replace function finance_private.valid_fields(f jsonb) returns jsonb
language plpgsql immutable set search_path='' as $$
declare d date;v numeric;
begin
 if jsonb_typeof(f)<>'object' or coalesce(f->>'source','')='' or length(f->>'source')>500 then raise exception 'A merchant is required.';end if;
 if coalesce(f->>'date','') !~ '^\d{4}-\d{2}-\d{2}$' then raise exception 'A valid date is required.';end if;
 d=(f->>'date')::date;v=round((f->>'value')::numeric,2);
 if v is null or v<=0 or v::text in ('NaN','Infinity','-Infinity') or v>999999999 then raise exception 'Enter a positive, finite amount.';end if;
 if coalesce(f->>'type','') not in ('Inflow','Outflow','Investment') then raise exception 'Invalid transaction type.';end if;
 return jsonb_build_object('date',d,'value',round(v,2),'source',left(f->>'source',500),'bank',left(coalesce(f->>'bank','Cash'),500),'type',f->>'type','category',left(coalesce(f->>'category','Uncategorized'),500),'final_category',left(coalesce(f->>'final_category',f->>'category','Uncategorized'),500),'cost_revenue_type',left(coalesce(f->>'cost_revenue_type',''),500));
end $$;
create or replace function finance_private.keep_correction(t public.transactions) returns void
language plpgsql security definer set search_path='' as $$
begin
 if t.row_hash is not null and t.row_hash not like 'app:%' then
  insert into public.app_state(key,value,updated_at) values('txn-edit:'||t.row_hash,jsonb_build_object('fields',jsonb_build_object('date',t.date,'value',t.value,'source',t.source,'bank',t.bank,'type',t.type,'category',t.category,'final_category',t.final_category,'cost_revenue_type',t.cost_revenue_type)),now()) on conflict(key) do update set value=excluded.value,updated_at=excluded.updated_at;
 end if;
end $$;
create or replace function public.finance_save_entry(p_fields jsonb,p_id bigint default null,p_token text default null,p_expected timestamptz default null,p_receipt uuid default null) returns jsonb
language plpgsql security definer set search_path='' as $$
declare f jsonb;t public.transactions;rc public.finance_receipts;h bigint;
begin
 if not public.finance_is_owner() then raise exception 'Not authorized' using errcode='42501';end if;
 f=finance_private.valid_fields(p_fields);
 if p_receipt is not null then
  select * into rc from public.finance_receipts where id=p_receipt for update;
  if not found then raise exception 'Receipt not found.';end if;
  if rc.status='linked' and p_id is not null and rc.transaction_id<>p_id then raise exception 'Receipt is already attached to another entry.';end if;
  if rc.status='linked' and p_id is null then select * into t from public.transactions where id=rc.transaction_id;return jsonb_build_object('transaction',to_jsonb(t),'already_linked',true);end if;
 end if;
 if p_id is null then
  if coalesce(p_token,'') !~ '^app:[a-zA-Z0-9-]{20,80}$' then raise exception 'Invalid save token.';end if;
  insert into public.transactions(date,value,source,bank,type,category,final_category,cost_revenue_type,row_hash)
  values((f->>'date')::date,(f->>'value')::numeric,f->>'source',f->>'bank',f->>'type',f->>'category',f->>'final_category',f->>'cost_revenue_type',p_token)
  on conflict(row_hash) do nothing returning * into t;
  if t.id is null then select * into t from public.transactions where row_hash=p_token;end if;
 else
  select * into t from public.transactions where id=p_id for update;
  if not found or t.deleted_at is not null then raise exception 'This entry is no longer active.';end if;
  if p_expected is null or t.updated_at<>p_expected then raise exception 'This entry changed elsewhere. Reload it before saving.';end if;
  update public.transactions set date=(f->>'date')::date,value=(f->>'value')::numeric,source=f->>'source',bank=f->>'bank',type=f->>'type',category=f->>'category',final_category=f->>'final_category',cost_revenue_type=f->>'cost_revenue_type',row_hash=coalesce(row_hash,'app:'||gen_random_uuid()) where id=p_id returning * into t;
  perform finance_private.keep_correction(t);
 end if;
 if p_receipt is not null then update public.finance_receipts set status='linked',transaction_id=t.id,updated_at=now() where id=p_receipt;end if;
 select id into h from public.finance_history where transaction_id=t.id order by id desc limit 1;
 return jsonb_build_object('transaction',to_jsonb(t),'history_id',h);
end $$;
create or replace function public.finance_link_receipt(p_receipt uuid,p_transaction bigint) returns void
language plpgsql security definer set search_path='' as $$
declare rc public.finance_receipts;
begin
 if not public.finance_is_owner() then raise exception 'Not authorized' using errcode='42501';end if;
 select * into rc from public.finance_receipts where id=p_receipt for update;
 if not found then raise exception 'Receipt not found.';end if;
 if rc.status='linked' and rc.transaction_id<>p_transaction then raise exception 'Receipt is already attached to another entry.';end if;
 perform 1 from public.transactions where id=p_transaction and deleted_at is null for share;
 if not found then raise exception 'Active transaction not found.';end if;
 update public.finance_receipts set transaction_id=p_transaction,status='linked',updated_at=now() where id=p_receipt;
end $$;
create or replace function public.finance_set_deleted(p_id bigint,p_deleted boolean,p_expected timestamptz) returns jsonb
language plpgsql security definer set search_path='' as $$
declare t public.transactions;h bigint;
begin
 if not public.finance_is_owner() then raise exception 'Not authorized' using errcode='42501';end if;
 select * into t from public.transactions where id=p_id for update;
 if not found or p_expected is null or t.updated_at<>p_expected then raise exception 'This entry changed. Reload before continuing.';end if;
 update public.transactions set deleted_at=case when p_deleted then now() else null end where id=p_id returning * into t;
 select id into h from public.finance_history where transaction_id=p_id order by id desc limit 1;
 return jsonb_build_object('transaction',to_jsonb(t),'history_id',h);
end $$;
create or replace function public.finance_restore_history(p_history bigint,p_expected timestamptz) returns jsonb
language plpgsql security definer set search_path='' as $$
declare hist public.finance_history;t public.transactions;old_t public.transactions;
begin
 if not public.finance_is_owner() then raise exception 'Not authorized' using errcode='42501';end if;
 select * into hist from public.finance_history where id=p_history;
 if not found then raise exception 'Change not found.';end if;
 select * into t from public.transactions where id=hist.transaction_id for update;
 if not found or p_expected is null or t.updated_at<>p_expected then raise exception 'This entry changed. Reload before undoing.';end if;
 if hist.old_record is null then update public.transactions set deleted_at=now() where id=t.id returning * into t;
 else
  old_t=jsonb_populate_record(null::public.transactions,hist.old_record);
  update public.transactions set date=old_t.date,date_2=old_t.date_2,value=old_t.value,source=old_t.source,bank=old_t.bank,type=old_t.type,cost_revenue_type=old_t.cost_revenue_type,category=old_t.category,discount=old_t.discount,final_category=old_t.final_category,found_in_statements=old_t.found_in_statements,deleted_at=old_t.deleted_at where id=t.id returning * into t;
  perform finance_private.keep_correction(t);
 end if;
 return to_jsonb(t);
end $$;

alter table public.finance_receipts enable row level security;
alter table public.finance_history enable row level security;
alter table public.finance_backups enable row level security;
create policy finance_receipts_owner on public.finance_receipts for all to authenticated using(public.finance_is_owner()) with check(public.finance_is_owner());
create policy finance_receipts_backup on public.finance_receipts for select to anon using(public.finance_worker_scope('backup'));
create policy finance_history_read on public.finance_history for select to authenticated using(public.finance_is_owner());
create policy finance_history_backup on public.finance_history for select to anon using(public.finance_worker_scope('backup'));
create policy finance_backups_read on public.finance_backups for select to authenticated using(public.finance_is_owner());
create policy finance_backups_insert on public.finance_backups for insert to authenticated with check(public.finance_is_owner());
create policy finance_backups_worker_read on public.finance_backups for select to anon using(public.finance_worker_scope('backup'));
create policy finance_backups_worker_insert on public.finance_backups for insert to anon with check(public.finance_worker_scope('backup'));
revoke all on public.finance_receipts,public.finance_history,public.finance_backups from public,anon,authenticated;
grant select,insert,update on public.finance_receipts to authenticated;
grant select on public.finance_history to authenticated;
grant select,insert on public.finance_backups to authenticated;
grant select on public.finance_receipts,public.finance_history to anon;
grant select,insert on public.finance_backups to anon;
revoke all on function public.finance_save_entry(jsonb,bigint,text,timestamptz,uuid),public.finance_link_receipt(uuid,bigint),public.finance_set_deleted(bigint,boolean,timestamptz),public.finance_restore_history(bigint,timestamptz) from public;
grant execute on function public.finance_save_entry(jsonb,bigint,text,timestamptz,uuid),public.finance_link_receipt(uuid,bigint),public.finance_set_deleted(bigint,boolean,timestamptz),public.finance_restore_history(bigint,timestamptz) to authenticated;

insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types) values
('finance-receipts','finance-receipts',false,20971520,array['image/jpeg','image/png','image/webp','application/pdf']),
('finance-backups','finance-backups',false,52428800,array['application/gzip','application/json'])
on conflict(id) do update set public=false,file_size_limit=excluded.file_size_limit,allowed_mime_types=excluded.allowed_mime_types;
create policy finance_files_owner_read on storage.objects for select to authenticated using(bucket_id in ('finance-receipts','finance-backups') and public.finance_is_owner());
create policy finance_files_owner_insert on storage.objects for insert to authenticated with check(bucket_id in ('finance-receipts','finance-backups') and public.finance_is_owner());
create policy finance_backups_worker_file_insert on storage.objects for insert to anon with check(bucket_id='finance-backups' and public.finance_worker_scope('backup'));
-- The backup worker may upload files, but only the signed-in owner may download them.
-- Storage/CDN caching keys on JWT identity, not a custom worker header.

-- One statement gives every table the same database snapshot, even during import.
create or replace function public.finance_export_snapshot() returns jsonb
language sql stable security definer set search_path='' as $$
 select case when public.finance_is_owner() or public.finance_worker_scope('backup') then
 jsonb_build_object('format_version',1,'created_at',now(),
 'transactions',(select coalesce(jsonb_agg(t order by t.id),'[]') from public.transactions t),
 'app_state',(select coalesce(jsonb_agg(s order by s.key),'[]') from public.app_state s),
 'finance_receipts',(select coalesce(jsonb_agg(r order by r.id),'[]') from public.finance_receipts r),
 'finance_history',(select coalesce(jsonb_agg(h order by h.id),'[]') from public.finance_history h)) else null end;
$$;
revoke all on function public.finance_export_snapshot() from public;
grant execute on function public.finance_export_snapshot() to authenticated,anon;
commit;
