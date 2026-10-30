-- Deferred Claim validity is enforced at the database boundary, matching the read model.
create or replace function private.document_reporting_period(
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
    and claimed_start > private.reporting_period_start(assigned_period)
    and claimed_start <= tax_point_date + interval '3 years' then
    return document_claimed_reporting_period;
  end if;
  return assigned_period;
end;
$$;

create or replace function public.update_document_reporting(
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
      or claimed_start > tax_point_date + interval '3 years'
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

