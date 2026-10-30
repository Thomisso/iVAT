-- ADR-0012: every Document defaults to the Reporting Period of its Tax Point
-- Date. The Receipt Date is retired; the Import Date (the Source File's upload
-- date) is informational only. A Deferred Claim stays the Document's
-- claimed_reporting_period.

drop view public.document_overview;
drop view public.vat_report_document;
drop trigger document_receipt_date_default on public.document;
drop function private.default_document_receipt_date();
drop function public.update_document_reporting(uuid, date, text);
drop function private.reporting_period_readiness_source(uuid, text);
drop function private.reporting_period_readiness_documents(uuid, text);

-- Invalid AI dates stay unassigned instead of breaking a list or report.
-- Mirrored by reportingPeriodForDocument in src/application/vat-rules.ts.
create function private.document_reporting_period(
  target_company_id uuid,
  document_direction text,
  tax_point_date_text text,
  document_claimed_reporting_period text
)
returns text
language plpgsql stable security definer set search_path = ''
as $$
declare
  tax_point_date date;
  assigned_period text;
  claimed_start date;
begin
  if tax_point_date_text is null
    or tax_point_date_text !~ '^20[0-9]{2}-(0[1-9]|1[0-2])-[0-9]{2}$' then
    return null;
  end if;
  begin
    tax_point_date := tax_point_date_text::date;
  exception when datetime_field_overflow or invalid_datetime_format then
    -- Keep a malformed Extraction visible as an exclusion in the period its
    -- year and month indicate; it must not disappear from review.
    tax_point_date := (left(tax_point_date_text, 7) || '-01')::date;
  end;
  assigned_period := private.reporting_period_for_date(target_company_id, tax_point_date);
  if document_direction is distinct from 'incoming'
    or document_claimed_reporting_period is null then
    return assigned_period;
  end if;
  claimed_start := private.reporting_period_start(document_claimed_reporting_period);
  if claimed_start is not null
    and private.reporting_period_for_date(target_company_id, claimed_start)
      = document_claimed_reporting_period
    and claimed_start > private.reporting_period_start(assigned_period) then
    return document_claimed_reporting_period;
  end if;
  return assigned_period;
end;
$$;

revoke execute on function private.document_reporting_period(uuid, text, text, text)
  from public;
grant execute on function private.document_reporting_period(uuid, text, text, text)
  to authenticated;

create or replace function private.document_reporting_period_for(doc public.document, payload jsonb)
returns text
language sql stable security definer set search_path = ''
as $$
  select private.document_reporting_period(
    ($1).company_id,
    $2 ->> 'direction',
    $2 ->> 'taxPointDate',
    ($1).claimed_reporting_period
  );
$$;

drop function private.document_reporting_period(uuid, text, text, date, text);
alter table public.document drop column receipt_date;

-- A Company member may clear an incoming Document's Deferred Claim or move it
-- strictly after its Tax Point Date's Reporting Period. The Period Lock
-- trigger refuses the change when either period is locked (ADR-0007).
create function public.update_document_reporting(
  target_document_id uuid,
  new_claimed_reporting_period text
)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  doc public.document;
  payload jsonb;
  tax_point_date date;
  assigned_period text;
  claimed_start date;
begin
  select * into doc from public.document where id = target_document_id for update;
  if not found or not private.can_access_company(doc.company_id, doc.organization_id) then
    raise exception 'not allowed' using errcode = '42501';
  end if;

  select version.payload into payload
  from public.extraction_version version
  where version.document_id = doc.id
  order by version.version desc
  limit 1;
  if coalesce(payload ->> 'direction', '') <> 'incoming' then
    raise exception 'only an incoming Document has a Deferred Claim'
      using errcode = 'P0001', hint = 'incoming_required';
  end if;
  begin
    tax_point_date := (payload ->> 'taxPointDate')::date;
  exception when datetime_field_overflow or invalid_datetime_format then
    raise exception 'a valid Tax Point Date is required'
      using errcode = 'P0001', hint = 'invalid_tax_point_date';
  end;
  if tax_point_date is null then
    raise exception 'a valid Tax Point Date is required'
      using errcode = 'P0001', hint = 'invalid_tax_point_date';
  end if;

  assigned_period := private.reporting_period_for_date(doc.company_id, tax_point_date);
  if assigned_period is null then
    raise exception 'the Tax Point Date is outside every Reporting Year'
      using errcode = 'P0001', hint = 'invalid_reporting_period';
  end if;

  if new_claimed_reporting_period is not null then
    claimed_start := private.reporting_period_start(new_claimed_reporting_period);
    if claimed_start is null
      or private.reporting_period_for_date(doc.company_id, claimed_start)
        is distinct from new_claimed_reporting_period then
      raise exception 'the claimed Reporting Period is not a Reporting Period of the Company'
        using errcode = 'P0001', hint = 'invalid_reporting_period';
    end if;
    if claimed_start <= private.reporting_period_start(assigned_period) then
      raise exception 'the claimed Reporting Period must be later'
        using errcode = 'P0001', hint = 'claimed_period_not_later';
    end if;
  end if;

  if doc.claimed_reporting_period is not distinct from new_claimed_reporting_period then
    return;
  end if;

  update public.document
  set claimed_reporting_period = new_claimed_reporting_period
  where id = doc.id;

  perform private.record_audit_event(
    'document.reporting_assignment_changed',
    doc.organization_id,
    doc.company_id,
    'document',
    doc.id,
    jsonb_build_object(
      'claimed_reporting_period', jsonb_build_object(
        'from', doc.claimed_reporting_period,
        'to', new_claimed_reporting_period
      )
    )
  );
end;
$$;

revoke execute on function public.update_document_reporting(uuid, text)
  from public, anon, service_role;
grant execute on function public.update_document_reporting(uuid, text)
  to authenticated;

create view public.document_overview with (security_invoker = true) as
select
  d.id,
  d.organization_id,
  d.company_id,
  d.source_file_id,
  d.first_page,
  d.last_page,
  d.status,
  d.created_at,
  v.version,
  v.payload ->> 'documentNumber' as document_number,
  v.payload ->> 'direction' as direction,
  v.payload ->> 'taxPointDate' as tax_point_date,
  private.document_reporting_period(
    d.company_id,
    v.payload ->> 'direction',
    v.payload ->> 'taxPointDate',
    d.claimed_reporting_period
  ) as reporting_period,
  c.party ->> 'name' as counterparty_name,
  c.party ->> 'vatId' as counterparty_vat_id,
  c.party ->> 'ico' as counterparty_ico,
  concat_ws(E'\n', c.party ->> 'name', c.party ->> 'vatId', c.party ->> 'ico') as counterparty_search,
  v.payload ->> 'currency' as currency,
  v.payload -> 'totals' ->> 'grossAmount' as gross_amount,
  coalesce(jsonb_array_length(v.findings), 0) as finding_count,
  (sf.uploaded_at at time zone 'Europe/Prague')::date as import_date,
  d.claimed_reporting_period
from public.document d
join public.source_file sf on sf.id = d.source_file_id
left join lateral (
  select ev.version, ev.payload, ev.findings
  from public.extraction_version ev
  where ev.document_id = d.id
  order by ev.version desc
  limit 1
) v on true
left join lateral (
  select case v.payload ->> 'direction'
    when 'incoming' then v.payload -> 'supplier'
    when 'outgoing' then v.payload -> 'customer'
  end as party
) c on true
where d.superseded_at is null;

create view public.vat_report_document with (security_invoker = true) as
select
  d.id,
  d.organization_id,
  d.company_id,
  d.status,
  v.id as extraction_version_id,
  v.payload,
  d.claimed_reporting_period
from public.document d
left join lateral (
  select ev.id, ev.payload from public.extraction_version ev
  where ev.document_id = d.id order by ev.version desc limit 1
) v on true;

revoke all on public.document_overview, public.vat_report_document from anon, authenticated;
grant select on public.document_overview, public.vat_report_document to authenticated;

create or replace function public.vat_report_documents(
  target_company_id uuid,
  target_period text
)
returns jsonb language sql stable security invoker set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', d.id,
    'status', d.status,
    'extractionVersionId', d.extraction_version_id,
    'payload', d.payload,
    'claimedReportingPeriod', d.claimed_reporting_period
  ) order by d.id), '[]'::jsonb)
  from public.vat_report_document d
  where d.company_id = target_company_id
    and private.document_reporting_period(
      d.company_id,
      d.payload ->> 'direction',
      d.payload ->> 'taxPointDate',
      d.claimed_reporting_period
    ) = target_period;
$$;

-- A Document without a Reporting Period (still in Extraction, failed, or
-- without a valid Tax Point Date) still blocks the readiness of the period of
-- its Import Date, so unfinished work is not overlooked. It does not join the
-- VAT Report of that period.
create function private.reporting_period_readiness_documents(
  target_company_id uuid,
  target_period text
)
returns table (
  document_id uuid,
  status public.document_status,
  extraction_version_id uuid,
  payload jsonb,
  findings jsonb,
  claimed_reporting_period text
)
language sql stable security definer set search_path = ''
as $$
  select
    document.id,
    document.status,
    version.id,
    version.payload,
    version.findings,
    document.claimed_reporting_period
  from public.document document
  join public.source_file source on source.id = document.source_file_id
  left join lateral (
    select extraction.id, extraction.payload, extraction.findings
    from public.extraction_version extraction
    where extraction.document_id = document.id
    order by extraction.version desc
    limit 1
  ) version on true
  cross join lateral (
    select private.document_reporting_period(
      document.company_id,
      version.payload ->> 'direction',
      version.payload ->> 'taxPointDate',
      document.claimed_reporting_period
    ) as period
  ) assignment
  where document.company_id = target_company_id
    and document.superseded_at is null
    and (
      assignment.period = target_period
      or (
        assignment.period is null
        and private.reporting_period_for_date(
          document.company_id,
          (source.uploaded_at at time zone 'Europe/Prague')::date
        ) = target_period
      )
    );
$$;

create function private.reporting_period_readiness_source(
  target_company_id uuid,
  target_period text
)
returns jsonb
language sql stable security definer set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'documentId', document.document_id,
    'status', document.status,
    'extractionVersionId', document.extraction_version_id,
    'claimedReportingPeriod', document.claimed_reporting_period
  ) order by document.document_id), '[]'::jsonb)
  from private.reporting_period_readiness_documents(
    target_company_id,
    target_period
  ) document;
$$;

revoke execute on function private.reporting_period_readiness_documents(uuid, text),
  private.reporting_period_readiness_source(uuid, text)
  from public;

-- Saved VAT Report sources drop the retired key, so a report whose Documents
-- did not change stays current. A report whose Documents move under the new
-- rule becomes stale through the usual source comparison.
alter table public.vat_report disable trigger vat_report_period_lock;
update public.vat_report
set documents = (
      select coalesce(jsonb_agg(item - 'receiptDate' order by ordinality), '[]'::jsonb)
      from jsonb_array_elements(documents) with ordinality as entry(item, ordinality)
    ),
    result = case
      when jsonb_typeof(result -> 'readinessSource') = 'array' then jsonb_set(
        result,
        '{readinessSource}',
        (
          select coalesce(jsonb_agg(item - 'receiptDate' order by ordinality), '[]'::jsonb)
          from jsonb_array_elements(result -> 'readinessSource') with ordinality as entry(item, ordinality)
        )
      )
      else result
    end
where documents @? '$[*].receiptDate'
  or result @? '$.readinessSource[*].receiptDate';
alter table public.vat_report enable trigger vat_report_period_lock;

create or replace function private.company_export_snapshot_without_ai_credential_source(target_company_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  target public.company;
begin
  select * into target from public.company where id = target_company_id;
  if not found or not private.can_administrate_company(target.id, target.organization_id) then
    raise exception 'not allowed' using errcode = '42501';
  end if;

  return jsonb_build_object(
    'revision', target.data_revision,
    'company', jsonb_build_object(
      'id', target.id,
      'organizationId', target.organization_id,
      'name', target.name,
      'firstName', target.first_name,
      'lastName', target.last_name,
      'ico', target.ico,
      'vatId', target.vat_id,
      'street', private.registered_street(target.street_name, target.house_number, target.orientation_number),
      'streetName', target.street_name,
      'houseNumber', target.house_number,
      'orientationNumber', target.orientation_number,
      'city', target.city,
      'postalCode', target.postal_code,
      'personType', target.person_type,
      'aiProcessing', case when target.ai_processing_enabled then jsonb_build_object(
        'provider', target.ai_provider, 'region', target.ai_region
      ) else 'null'::jsonb end
    ),
    'setupSteps', coalesce((
      select jsonb_agg(jsonb_build_object(
        'step', setup.step,
        'state', setup.state,
        'changedAt', setup.changed_at
      ) order by setup.step)
      from public.company_setup_step_state setup
      where setup.company_id = target.id
    ), '[]'::jsonb),
    'reportingYears', coalesce((
      select jsonb_agg(jsonb_build_object(
        'year', reporting_year.year,
        'frequency', reporting_year.frequency,
        'firstMonth', reporting_year.first_month
      ) order by reporting_year.year)
      from public.reporting_year
      where reporting_year.company_id = target.id
    ), '[]'::jsonb),
    'sourceFiles', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', source.id, 'companyId', source.company_id,
        'fileName', source.file_name, 'format', source.format,
        'byteSize', source.byte_size, 'sha256', source.sha256,
        'pageCount', source.page_count,
        'preselectedDirection', source.preselected_direction,
        'status', source.status, 'uploadedAt', source.uploaded_at
      ) order by source.uploaded_at desc, source.id)
      from public.source_file source where source.company_id = target.id
    ), '[]'::jsonb),
    'documents', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'id', document.id, 'companyId', document.company_id,
          'sourceFileId', document.source_file_id,
          'firstPage', document.first_page, 'lastPage', document.last_page,
          'status', document.status, 'createdAt', document.created_at,
          'claimedReportingPeriod', document.claimed_reporting_period,
          'supersededAt', document.superseded_at,
          'extractionVersions', coalesce((
            select jsonb_agg(jsonb_build_object(
              'id', version.id, 'documentId', version.document_id,
              'version', version.version,
              'author', case when version.author_user_id is null
                then jsonb_build_object('kind', 'ai', 'provider', version.provider, 'model', version.model)
                else jsonb_build_object('kind', 'user', 'userId', version.author_user_id) end,
              'payload', version.payload, 'findings', version.findings,
              'createdAt', version.created_at
            ) order by version.version)
            from public.extraction_version version where version.document_id = document.id
          ), '[]'::jsonb)
        ) || case when document.source_sheet is null then '{}'::jsonb else jsonb_build_object(
          'rowSet', jsonb_build_object(
            'sheetName', document.source_sheet,
            'firstRow', document.first_row,
            'lastRow', document.last_row
          ),
          'hasDocumentImage', false
        ) end
        order by document.created_at, document.id
      ) from public.document document where document.company_id = target.id
    ), '[]'::jsonb)
  );
end;
$function$;

-- Every reported or locked period must survive the conversion unchanged.
do $$
declare
  lost record;
begin
  select reported.company_id, reported.period into lost
  from (
    select company_id, period from public.vat_report
    union
    select company_id, period from public.period_lock
  ) reported
  where private.reporting_period_for_date(
    reported.company_id, private.reporting_period_start(reported.period)
  ) is distinct from reported.period
  limit 1;
  if found then
    raise exception 'Reporting Year migration would lose period % of Company %',
      lost.period, lost.company_id;
  end if;
end;
$$;

