-- Preserve the invoker/RLS boundary and complete current report projection while
-- avoiding a second Document access check for every row already in the report.
create or replace function public.vat_report_documents(target_company_id uuid, target_period text)
returns jsonb language sql stable security invoker set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', d.id,
    'status', d.status,
    'extractionVersionId', v.id,
    'payload', v.payload,
    'claimedReportingPeriod', d.claimed_reporting_period,
    'importDate', (s.uploaded_at at time zone 'Europe/Prague')::date,
    'sourceFileId', d.source_file_id
  ) order by d.id), '[]'::jsonb)
  from public.document d
  left join public.source_file s on s.id = d.source_file_id and s.company_id = target_company_id
  left join lateral (
    select ev.id, ev.payload from public.extraction_version ev
    where ev.document_id = d.id order by ev.version desc limit 1
  ) v on true
  where d.company_id = target_company_id
    and private.document_reporting_period(d.company_id, v.payload ->> 'direction',
      v.payload ->> 'taxPointDate', d.claimed_reporting_period) = target_period;
$$;
revoke all on function public.vat_report_documents(uuid, text) from public, anon, service_role;
grant execute on function public.vat_report_documents(uuid, text) to authenticated;
