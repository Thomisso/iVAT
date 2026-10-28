-- Finalizing a VAT Report locks its Reporting Period (ADR-0007). The lock is a
-- separate lifecycle record: the stored report remains the immutable target of
-- both the finalization and a later audited unlock.

create table public.period_lock (
  company_id uuid not null,
  organization_id uuid not null,
  period text not null,
  vat_report_id uuid not null references public.vat_report(id),
  locked_by uuid not null references auth.users(id),
  locked_at timestamptz not null default now(),
  primary key (company_id, period),
  foreign key (company_id, organization_id) references public.company(id, organization_id)
);

alter table public.period_lock enable row level security;
revoke all on public.period_lock from public, anon, authenticated, service_role;
grant select on public.period_lock to authenticated;
create policy "members read their companies' period locks" on public.period_lock
  for select to authenticated
  using (private.can_access_company(company_id, organization_id));

create function private.is_reporting_period_locked(target_company_id uuid, target_period text)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.period_lock l
    where l.company_id = target_company_id and l.period = target_period
  );
$$;

revoke execute on function private.is_reporting_period_locked(uuid, text) from public;

create function public.finalize_vat_report(target_company_id uuid, target_period text)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  company public.company;
  report public.vat_report;
begin
  select * into company from public.company where id = target_company_id for update;
  if not found or not private.can_administrate_company(company.id, company.organization_id) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  select * into report from public.vat_report
    where company_id = company.id and period = target_period for update;
  if not found then
    raise exception 'a stored VAT Report is required' using errcode = 'P0001', hint = 'report_not_found';
  end if;

  -- Serialize finalization against every document-changing command. Those
  -- commands lock their Document before checking period_lock.
  perform id from public.document where company_id = company.id order by id for update;
  insert into public.period_lock (
    company_id, organization_id, period, vat_report_id, locked_by
  ) values (
    company.id, company.organization_id, report.period, report.id, auth.uid()
  ) on conflict (company_id, period) do nothing;

  if found then
    perform private.record_audit_event(
      'vat_report.finalized', company.organization_id, company.id,
      'vat_report', report.id, jsonb_build_object('period', report.period)
    );
  end if;
end;
$$;

create function public.unlock_reporting_period(target_company_id uuid, target_period text)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  company public.company;
  unlocked_report_id uuid;
begin
  select * into company from public.company where id = target_company_id for update;
  if not found or not private.can_administrate_company(company.id, company.organization_id) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  delete from public.period_lock
    where company_id = company.id and period = target_period
    returning vat_report_id into unlocked_report_id;
  if unlocked_report_id is null then
    raise exception 'the Reporting Period is not locked' using errcode = 'P0001', hint = 'not_locked';
  end if;
  perform private.record_audit_event(
    'reporting_period.unlocked', company.organization_id, company.id,
    'vat_report', unlocked_report_id, jsonb_build_object('period', target_period)
  );
end;
$$;

revoke execute on function public.finalize_vat_report, public.unlock_reporting_period
  from public, anon, service_role;
grant execute on function public.finalize_vat_report(uuid, text),
  public.unlock_reporting_period(uuid, text) to authenticated;

-- The assigned period is derived from the latest immutable Extraction Version.
-- Ticket #43 replaces this body with Receipt Date / claimed-period semantics;
-- the lock guards below deliberately depend on this one private seam.
create function private.document_current_reporting_period(target_document_id uuid)
returns text
language sql stable security definer set search_path = ''
as $$
  select case
    when v.payload ->> 'taxPointDate' ~ '^20\d{2}-(0[1-9]|1[0-2])-\d{2}$'
      then left(v.payload ->> 'taxPointDate', 7)
  end
  from public.extraction_version v
  where v.document_id = target_document_id
  order by v.version desc
  limit 1;
$$;

create function private.payload_reporting_period(payload jsonb)
returns text
language sql immutable security definer set search_path = ''
as $$
  select case
    when payload ->> 'taxPointDate' ~ '^20\d{2}-(0[1-9]|1[0-2])-\d{2}$'
      then left(payload ->> 'taxPointDate', 7)
  end;
$$;

create function private.refuse_locked_document_change()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  assigned_period text;
begin
  assigned_period := private.document_current_reporting_period(old.id);
  if assigned_period is not null
    and private.is_reporting_period_locked(old.company_id, assigned_period) then
    raise exception 'the Reporting Period is locked'
      using errcode = 'P0001', hint = 'period_locked';
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

create trigger document_period_lock
  before update or delete on public.document
  for each row execute function private.refuse_locked_document_change();

create function private.refuse_locked_extraction_version()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  old_period text;
  new_period text;
begin
  old_period := private.document_current_reporting_period(new.document_id);
  new_period := private.payload_reporting_period(new.payload);
  if (old_period is not null and private.is_reporting_period_locked(new.company_id, old_period))
    or (new_period is not null and private.is_reporting_period_locked(new.company_id, new_period)) then
    raise exception 'the Reporting Period is locked'
      using errcode = 'P0001', hint = 'period_locked';
  end if;
  return new;
end;
$$;

create trigger extraction_version_period_lock
  before insert on public.extraction_version
  for each row execute function private.refuse_locked_extraction_version();

create function private.refuse_locked_vat_report_change()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if private.is_reporting_period_locked(old.company_id, old.period) then
    raise exception 'the Reporting Period is locked'
      using errcode = 'P0001', hint = 'period_locked';
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

create trigger vat_report_period_lock
  before update or delete on public.vat_report
  for each row execute function private.refuse_locked_vat_report_change();

-- Split-correction commands validate the lock before their shape-specific
-- preconditions, so a locked Document has one stable refusal across commands.
create or replace function private.assert_split_document_correctable(doc public.document)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  assigned_period text;
begin
  if doc.superseded_at is not null or doc.status in ('uploaded', 'processing') then
    raise exception 'the Split is being processed' using errcode = 'P0001', hint = 'not_correctable';
  end if;
  assigned_period := private.document_current_reporting_period(doc.id);
  if assigned_period is not null
    and private.is_reporting_period_locked(doc.company_id, assigned_period) then
    raise exception 'the Reporting Period is locked'
      using errcode = 'P0001', hint = 'period_locked';
  end if;
end;
$$;

revoke execute on function private.document_current_reporting_period(uuid),
  private.payload_reporting_period(jsonb), private.refuse_locked_document_change(),
  private.refuse_locked_extraction_version(), private.refuse_locked_vat_report_change()
  from public;
