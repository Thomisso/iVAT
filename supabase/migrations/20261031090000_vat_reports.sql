-- A stored draft contains its computed output and immutable source versions.
create table public.vat_report (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organization(id),
  company_id uuid not null,
  period text not null check (period ~ '^20[0-9]{2}-(0[1-9]|1[0-2])$'),
  result jsonb not null,
  documents jsonb not null check (jsonb_typeof(documents) = 'array'),
  generated_by uuid not null references auth.users(id),
  generated_at timestamptz not null default now(),
  foreign key (company_id, organization_id) references public.company(id, organization_id),
  unique (company_id, period)
);
alter table public.vat_report enable row level security;
revoke all on public.vat_report from public, anon, authenticated, service_role;
grant select on public.vat_report to authenticated;
create policy "members read their companies' reports" on public.vat_report
  for select to authenticated using (private.can_access_company(company_id, organization_id));

-- Caller privileges preserve RLS on both the Document and Extraction Version.
create view public.vat_report_document with (security_invoker = true) as
select d.id, d.organization_id, d.company_id, d.status, v.id as extraction_version_id, v.payload
from public.document d
left join lateral (
  select ev.id, ev.payload from public.extraction_version ev
  where ev.document_id = d.id order by ev.version desc limit 1
) v on true;
revoke all on public.vat_report_document from public, anon, authenticated, service_role;
grant select on public.vat_report_document to authenticated;

-- One JSON value avoids PostgREST's row cap and defines the source selection
-- once for both computation and the transactional snapshot check. Invoker
-- privileges keep the underlying view's RLS in force for application reads.
create function public.vat_report_documents(target_company_id uuid, target_period text)
returns jsonb language sql stable security invoker set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', d.id, 'status', d.status, 'extractionVersionId', d.extraction_version_id, 'payload', d.payload
  ) order by d.id), '[]'::jsonb)
  from public.vat_report_document d
  where d.company_id = target_company_id and d.payload ->> 'taxPointDate' like target_period || '-%';
$$;
revoke execute on function public.vat_report_documents from public, anon, service_role;
grant execute on function public.vat_report_documents(uuid, text) to authenticated;

-- Both Company Users and Administrators generate. Only this function writes
-- reports, validating the source snapshot and auditing the same transaction.
create function public.save_vat_report(target_company_id uuid, target_period text, expected_documents jsonb, computed_result jsonb)
returns uuid language plpgsql security definer set search_path = ''
as $$
declare
  company public.company;
  current_documents jsonb;
  report_id uuid;
begin
  select * into company from public.company where id = target_company_id for update;
  if not found or not private.can_access_company(company.id, company.organization_id) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if target_period is null or target_period !~ '^20[0-9]{2}-(0[1-9]|1[0-2])$' then
    raise exception 'invalid month' using errcode = 'P0001', hint = 'invalid_reporting_period';
  end if;
  -- Review transitions also lock these rows. Once locked, the latest versions
  -- and statuses stay stable until the report and audit event are committed.
  perform id from public.document where company_id = company.id order by id for share;
  current_documents := public.vat_report_documents(company.id, target_period);
  if current_documents is distinct from expected_documents then
    raise exception 'Documents changed during generation' using errcode = 'P0001', hint = 'stale_report';
  end if;
  insert into public.vat_report (organization_id, company_id, period, result, documents, generated_by)
  values (company.organization_id, company.id, target_period, computed_result, current_documents, auth.uid())
  on conflict (company_id, period) do update
    set result = excluded.result, documents = excluded.documents, generated_by = excluded.generated_by, generated_at = clock_timestamp()
  returning id into report_id;
  perform private.record_audit_event('vat_report.generated', company.organization_id, company.id, 'vat_report', report_id,
    jsonb_build_object('period', target_period, 'document_count', jsonb_array_length(current_documents)));
  return report_id;
end;
$$;
revoke execute on function public.save_vat_report from public, anon, service_role;
grant execute on function public.save_vat_report(uuid, text, jsonb, jsonb) to authenticated;
