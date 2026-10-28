-- Receipt Date and an explicit later input-VAT claim belong to the Document,
-- separately from its immutable extracted tax data.
alter table public.document
  add column receipt_date date,
  add column claimed_reporting_period text,
  add constraint document_claimed_reporting_period_format check (
    claimed_reporting_period is null
    or claimed_reporting_period ~ '^20[0-9]{2}-(0[1-9]|1[0-2]|Q[1-4])$'
  );

update public.document d
set receipt_date = (sf.uploaded_at at time zone 'Europe/Prague')::date
from public.source_file sf
where sf.id = d.source_file_id;

alter table public.document alter column receipt_date set not null;

-- New Documents default to the date their unchanged Source File was uploaded.
create function private.default_document_receipt_date()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if new.receipt_date is null then
    select (sf.uploaded_at at time zone 'Europe/Prague')::date into new.receipt_date
    from public.source_file sf
    where sf.id = new.source_file_id;
  end if;
  return new;
end;
$$;

create trigger document_receipt_date_default
  before insert on public.document
  for each row execute function private.default_document_receipt_date();

create function private.reporting_period_for_date(
  target_company_id uuid,
  target_date date
)
returns text
language sql stable security definer set search_path = ''
as $$
  select case frequency.frequency
    when 'monthly' then to_char(target_date, 'YYYY-MM')
    when 'quarterly' then to_char(target_date, 'YYYY') || '-Q'
      || extract(quarter from target_date)::integer::text
  end
  from public.company_filing_frequency frequency
  where frequency.company_id = target_company_id
    and frequency.effective_from <= target_date
  order by frequency.effective_from desc
  limit 1;
$$;

create function private.reporting_period_start(target_period text)
returns date
language sql immutable set search_path = ''
as $$
  select case
    when target_period ~ '^20[0-9]{2}-(0[1-9]|1[0-2])$'
      then (target_period || '-01')::date
    when target_period ~ '^20[0-9]{2}-Q[1-4]$'
      then (left(target_period, 4) || '-'
        || lpad((((right(target_period, 1)::integer - 1) * 3) + 1)::text, 2, '0')
        || '-01')::date
  end;
$$;

-- Invalid AI dates stay unassigned instead of breaking a list or report.
create function private.document_reporting_period(
  target_company_id uuid,
  document_direction text,
  tax_point_date_text text,
  document_receipt_date date,
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
  if document_direction = 'outgoing' then
    return private.reporting_period_for_date(target_company_id, tax_point_date);
  end if;
  if document_direction <> 'incoming' then
    return private.reporting_period_for_date(target_company_id, tax_point_date);
  end if;
  assigned_period := private.reporting_period_for_date(
    target_company_id,
    greatest(tax_point_date, document_receipt_date)
  );
  if document_claimed_reporting_period is not null then
    claimed_start := private.reporting_period_start(
      document_claimed_reporting_period
    );
    if claimed_start is not null
      and private.reporting_period_for_date(target_company_id, claimed_start)
        = document_claimed_reporting_period
      and claimed_start > private.reporting_period_start(assigned_period) then
      return document_claimed_reporting_period;
    end if;
  end if;
  return assigned_period;
end;
$$;

revoke execute on function private.default_document_receipt_date,
  private.reporting_period_for_date(uuid, date),
  private.reporting_period_start(text),
  private.document_reporting_period(uuid, text, text, date, text)
  from public;
grant execute on function private.document_reporting_period(uuid, text, text, date, text)
  to authenticated;

-- A Company member may edit the Receipt Date and may either clear the explicit
-- claim or move it strictly after the legal default Reporting Period.
create function public.update_document_reporting(
  target_document_id uuid,
  new_receipt_date date,
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
  assigned_start date;
  claimed_start date;
begin
  select * into doc from public.document where id = target_document_id for update;
  if not found or not private.can_access_company(doc.company_id, doc.organization_id) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if new_receipt_date is null then
    raise exception 'Receipt Date is required'
      using errcode = 'P0001', hint = 'invalid_receipt_date';
  end if;

  select version.payload into payload
  from public.extraction_version version
  where version.document_id = doc.id
  order by version.version desc
  limit 1;
  if coalesce(payload ->> 'direction', '') <> 'incoming' then
    raise exception 'only an incoming Document has a Receipt Date claim'
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

  assigned_period := private.reporting_period_for_date(
    doc.company_id,
    greatest(tax_point_date, new_receipt_date)
  );
  assigned_start := private.reporting_period_start(assigned_period);
  if assigned_period is null then
    raise exception 'the Company has no filing frequency for this date'
      using errcode = 'P0001', hint = 'invalid_reporting_period';
  end if;

  if new_claimed_reporting_period is not null then
    claimed_start := private.reporting_period_start(new_claimed_reporting_period);
    if claimed_start is null
      or private.reporting_period_for_date(doc.company_id, claimed_start)
        is distinct from new_claimed_reporting_period then
      raise exception 'the claimed Reporting Period does not match the Company frequency'
        using errcode = 'P0001', hint = 'invalid_reporting_period';
    end if;
    if claimed_start <= assigned_start then
      raise exception 'the claimed Reporting Period must be later'
        using errcode = 'P0001', hint = 'claimed_period_not_later';
    end if;
  end if;

  if doc.receipt_date is not distinct from new_receipt_date
    and doc.claimed_reporting_period is not distinct from new_claimed_reporting_period then
    return;
  end if;

  update public.document
  set receipt_date = new_receipt_date,
      claimed_reporting_period = new_claimed_reporting_period
  where id = doc.id;

  perform private.record_audit_event(
    'document.reporting_assignment_changed',
    doc.organization_id,
    doc.company_id,
    'document',
    doc.id,
    jsonb_build_object(
      'receipt_date', jsonb_build_object(
        'from', doc.receipt_date,
        'to', new_receipt_date
      ),
      'claimed_reporting_period', jsonb_build_object(
        'from', doc.claimed_reporting_period,
        'to', new_claimed_reporting_period
      )
    )
  );
end;
$$;

revoke execute on function public.update_document_reporting(uuid, date, text)
  from public, anon, service_role;
grant execute on function public.update_document_reporting(uuid, date, text)
  to authenticated;

-- Keep list filtering and display on the same effective-dated assignment.
create or replace view public.document_overview with (security_invoker = true) as
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
    d.receipt_date,
    d.claimed_reporting_period
  ) as reporting_period,
  c.party ->> 'name' as counterparty_name,
  c.party ->> 'vatId' as counterparty_vat_id,
  c.party ->> 'ico' as counterparty_ico,
  concat_ws(E'\n', c.party ->> 'name', c.party ->> 'vatId', c.party ->> 'ico') as counterparty_search,
  v.payload ->> 'currency' as currency,
  v.payload -> 'totals' ->> 'grossAmount' as gross_amount,
  coalesce(jsonb_array_length(v.findings), 0) as finding_count,
  d.receipt_date,
  d.claimed_reporting_period
from public.document d
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

-- Reports may now use either a month or a quarter.
alter table public.vat_report drop constraint vat_report_period_check;
alter table public.vat_report add constraint vat_report_period_check check (
  period ~ '^20[0-9]{2}-(0[1-9]|1[0-2]|Q[1-4])$'
);

create or replace view public.vat_report_document with (security_invoker = true) as
select
  d.id,
  d.organization_id,
  d.company_id,
  d.status,
  v.id as extraction_version_id,
  v.payload,
  d.receipt_date,
  d.claimed_reporting_period
from public.document d
left join lateral (
  select ev.id, ev.payload from public.extraction_version ev
  where ev.document_id = d.id order by ev.version desc limit 1
) v on true;

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
    'receiptDate', d.receipt_date,
    'claimedReportingPeriod', d.claimed_reporting_period
  ) order by d.id), '[]'::jsonb)
  from public.vat_report_document d
  where d.company_id = target_company_id
    and private.document_reporting_period(
      d.company_id,
      d.payload ->> 'direction',
      d.payload ->> 'taxPointDate',
      d.receipt_date,
      d.claimed_reporting_period
    ) = target_period;
$$;

create or replace function public.save_vat_report(
  target_company_id uuid,
  target_period text,
  expected_documents jsonb,
  computed_result jsonb
)
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
  if private.reporting_period_start(target_period) is null
    or private.reporting_period_for_date(
      company.id,
      private.reporting_period_start(target_period)
    ) is distinct from target_period then
    raise exception 'invalid Reporting Period'
      using errcode = 'P0001', hint = 'invalid_reporting_period';
  end if;
  perform id from public.document where company_id = company.id order by id for share;
  current_documents := public.vat_report_documents(company.id, target_period);
  if current_documents is distinct from expected_documents then
    raise exception 'Documents changed during generation'
      using errcode = 'P0001', hint = 'stale_report';
  end if;
  insert into public.vat_report
    (organization_id, company_id, period, result, documents, generated_by)
  values (
    company.organization_id,
    company.id,
    target_period,
    computed_result,
    current_documents,
    auth.uid()
  )
  on conflict (company_id, period) do update
    set result = excluded.result,
        documents = excluded.documents,
        generated_by = excluded.generated_by,
        generated_at = clock_timestamp()
  returning id into report_id;
  perform private.record_audit_event(
    'vat_report.generated',
    company.organization_id,
    company.id,
    'vat_report',
    report_id,
    jsonb_build_object(
      'period', target_period,
      'document_count', jsonb_array_length(current_documents)
    )
  );
  return report_id;
end;
$$;
