-- Directory transitions follow the existing tuple -> Company lock order.
-- Document linking holds Company and reads the directory without tuple locks.
create or replace function private.lock_counterparty(target_company_id uuid, target_counterparty_id uuid)
returns public.counterparty language plpgsql security definer set search_path = '' as $$
declare entry public.counterparty; company public.company;
begin
  select * into entry from public.counterparty
    where company_id = target_company_id and id = target_counterparty_id for update;
  if not found then raise insufficient_privilege; end if;
  select * into company from public.company where id = entry.company_id for update;
  if not found or company.deleted_at is not null
    or not private.can_access_company(company.id, company.organization_id) then
    raise insufficient_privilege;
  end if;
  return entry;
end;
$$;
revoke all on function private.lock_counterparty(uuid, uuid) from public, anon, authenticated, service_role;

create or replace function public.archive_counterparty(target_company_id uuid, target_counterparty_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare entry public.counterparty;
begin
  entry := private.lock_counterparty(target_company_id, target_counterparty_id);
  if entry.archived_at is null then
    update public.counterparty set archived_at = now() where id = entry.id;
  end if;
end;
$$;
revoke all on function public.archive_counterparty(uuid, uuid) from public, anon, authenticated, service_role;
grant execute on function public.archive_counterparty(uuid, uuid) to authenticated;

create or replace function private.audit_counterparty()
returns trigger language plpgsql security definer set search_path = ''
as $$
declare
  values_after jsonb := to_jsonb(new) - array['id', 'organization_id', 'company_id', 'created_at'];
  changes jsonb;
begin
  if tg_op = 'DELETE' then
    perform private.record_audit_event('counterparty.deleted', old.organization_id, old.company_id,
      'counterparty', old.id, to_jsonb(old) - array['id', 'organization_id', 'company_id', 'created_at']);
    return old;
  elsif tg_op = 'INSERT' then
    perform private.record_audit_event('counterparty.created', new.organization_id, new.company_id,
      'counterparty', new.id, values_after);
  elsif old.archived_at is distinct from new.archived_at then
    perform private.record_audit_event(case when new.archived_at is null then 'counterparty.restored' else 'counterparty.archived' end, new.organization_id, new.company_id,
      'counterparty', new.id, jsonb_build_object('archivedAt', new.archived_at));
  else
    select jsonb_object_agg(e.key, jsonb_build_object('from', to_jsonb(old) -> e.key, 'to', e.value))
      into changes from jsonb_each(values_after) e where e.value is distinct from to_jsonb(old) -> e.key;
    if changes is not null then
      perform private.record_audit_event('counterparty.updated', new.organization_id, new.company_id,
        'counterparty', new.id, changes);
    end if;
  end if;
  return new;
end;
$$;

create or replace function public.restore_counterparty(target_company_id uuid, target_counterparty_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare entry public.counterparty;
begin
  entry := private.lock_counterparty(target_company_id, target_counterparty_id);
  if entry.archived_at is not null then
    update public.counterparty set archived_at = null where id = entry.id;
  end if;
end;
$$;
revoke all on function public.restore_counterparty(uuid, uuid) from public, anon, authenticated, service_role;
grant execute on function public.restore_counterparty(uuid, uuid) to authenticated;


drop function if exists public.search_counterparties(uuid, text, text);
create or replace function public.search_counterparties(target_company_id uuid, search_text text default '', directory_role text default '', directory_state text default 'active')
returns setof public.counterparty
language sql stable security invoker set search_path = ''
as $$
  select c.* from public.counterparty c
  where c.company_id = target_company_id and ((directory_state = 'active' and c.archived_at is null) or (directory_state = 'archived' and c.archived_at is not null))
    and (directory_role = '' or (directory_role = 'supplier' and c.supplier) or (directory_role = 'customer' and c.customer))
    and (btrim(search_text) = '' or position(lower(btrim(search_text)) in lower(c.name)) > 0
      or position(regexp_replace(btrim(search_text), '[[:space:]]', '', 'g') in c.ico) > 0
      or position(upper(regexp_replace(btrim(search_text), '[[:space:]]', '', 'g')) in c.vat_id) > 0);
$$;
revoke all on function public.search_counterparties(uuid, text, text, text) from public, anon, authenticated, service_role;
grant execute on function public.search_counterparties(uuid, text, text, text) to authenticated;


create or replace function public.delete_counterparty(target_company_id uuid, target_counterparty_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare entry public.counterparty;
begin
  entry := private.lock_counterparty(target_company_id, target_counterparty_id);
  -- The all-history trigger remains authoritative for every DELETE path.
  delete from public.counterparty where id = entry.id;
end;
$$;
revoke all on function public.delete_counterparty(uuid, uuid) from public, anon, authenticated, service_role;
grant execute on function public.delete_counterparty(uuid, uuid) to authenticated;
drop trigger if exists audit_counterparty_deleted on public.counterparty;
create trigger audit_counterparty_deleted after delete on public.counterparty
  for each row execute function private.audit_counterparty();

-- Preserve every recorded link, even when the current Version is unlinked.
create or replace function private.guard_counterparty_history()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  perform private.lock_counterparty(old.company_id, old.id);
  if exists (select 1 from public.extraction_version v where v.company_id = old.company_id and v.counterparty_id = old.id) then
    raise exception using errcode = 'P0001', message = 'Counterparty is referenced by recorded Documents', hint = 'counterparty_in_use';
  end if;
  return old;
end;
$$;
revoke all on function private.guard_counterparty_history() from public, anon, authenticated, service_role;
