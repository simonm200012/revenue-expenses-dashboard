begin;
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

commit;
