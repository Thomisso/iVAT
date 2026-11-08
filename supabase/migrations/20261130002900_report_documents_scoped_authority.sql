CREATE OR REPLACE FUNCTION public.vat_report_documents(target_company_id uuid, target_period text)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO ''
AS $candidate$
DECLARE actual_organization_id uuid;
BEGIN
  SELECT c.organization_id INTO actual_organization_id FROM public.company c WHERE c.id = target_company_id;
  IF NOT FOUND THEN RETURN '[]'::jsonb; END IF;
  IF private.can_access_company(target_company_id, actual_organization_id) IS NOT TRUE THEN RETURN '[]'::jsonb; END IF;
  RETURN (
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
    where ev.document_id = d.id
      and ev.company_id = d.company_id
      and ev.organization_id = d.organization_id
    order by ev.version desc limit 1
  ) v on true
  where d.company_id = target_company_id
    and private.document_reporting_period(d.company_id, v.payload ->> 'direction',
      v.payload ->> 'taxPointDate', d.claimed_reporting_period) = target_period
  );
END;
$candidate$;
revoke all on function public.vat_report_documents(uuid, text) from public, anon, service_role;
grant execute on function public.vat_report_documents(uuid, text) to authenticated;
