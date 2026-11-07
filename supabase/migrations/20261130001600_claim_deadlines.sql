-- Trusted external clock. Request fields and preparation dates never set today.
create function private.current_business_date()
returns date language sql stable set search_path = '' as $$
  select (statement_timestamp() at time zone 'Europe/Prague')::date;
$$;
revoke all on function private.current_business_date() from public, anon, authenticated, service_role;
create function public.current_business_date()
returns date language sql stable security definer set search_path = '' as $$
  select private.current_business_date();
$$;
revoke all on function public.current_business_date() from public, anon, service_role;
grant execute on function public.current_business_date() to authenticated;

-- Czech statutory non-working days (245/2000 Sb.); Good Friday from 2016.
-- Sources and evidence limits: docs/research/claim-deadline*.md.
create function private.next_czech_working_date(value date)
returns date language plpgsql immutable set search_path = '' as $$
declare y integer; a integer; b integer; c integer; d integer; e integer; g integer;
  h integer; l integer; m integer; n integer; easter date;
begin
  loop
    y := extract(year from value)::integer;
    a := y % 19; b := y / 100; c := y % 100; d := b / 4; e := b % 4;
    g := (b - (b + 8) / 25 + 1) / 3;
    h := (19 * a + b - d - g + 15) % 30;
    l := (32 + 2 * e + 2 * (c / 4) - h - c % 4) % 7;
    m := (a + 11 * h + 22 * l) / 451;
    n := h + l - 7 * m + 114;
    easter := make_date(y, n / 31, n % 31 + 1);
    if extract(isodow from value) < 6
      and to_char(value, 'MM-DD') not in ('01-01','05-01','05-08','07-05','07-06','09-28','10-28','11-17','12-24','12-25','12-26')
      and value <> easter + 1 and not (y >= 2016 and value = easter - 2) then return value; end if;
    value := value + 1;
  end loop;
end;
$$;
revoke all on function private.next_czech_working_date(date) from public, anon, authenticated, service_role;

-- Only supported ordinary supplies use this general limit. Entitlement arises
-- at the Tax Point Date, not upload or the confirmed earliest possession period.
create function private.claim_last_filing_date(target_company_id uuid, candidate jsonb)
returns date language plpgsql stable security definer set search_path = '' as $$
declare origin date; origin_period text; start_date date;
begin
  if not private.ordinary_domestic_claim(candidate) then return null; end if;
  origin := (candidate ->> 'taxPointDate')::date;
  origin_period := private.reporting_period_for_date(target_company_id, origin);
  if origin_period is null then return null; end if;
  if origin >= date '2025-01-01' then return private.next_czech_working_date(make_date(extract(year from origin)::integer + 2, 12, 31)); end if;
  start_date := private.reporting_period_start(origin_period);
  return private.next_czech_working_date((start_date + case when origin_period like '%-Q%' then interval '3 months' else interval '1 month' end + interval '3 years')::date);
end;
$$;
revoke all on function private.claim_last_filing_date(uuid, jsonb) from public, anon, authenticated, service_role;

alter function private.document_eligibility_error(uuid, uuid, jsonb, text) rename to document_eligibility_error_before_deadline;
create function private.document_eligibility_error(target_company_id uuid, target_document_id uuid, candidate jsonb, claimed_period text)
returns text language plpgsql stable security definer set search_path = '' as $$
declare refusal text; deadline date; chosen_start date; chosen_period text;
begin
  refusal := private.document_eligibility_error_before_deadline(target_company_id, target_document_id, candidate, claimed_period);
  if refusal is not null then return refusal; end if;
  deadline := private.claim_last_filing_date(target_company_id, candidate);
  if deadline is not null and private.current_business_date() > deadline then return 'claim_deadline_expired'; end if;
  chosen_period := coalesce(claimed_period, private.reporting_period_for_date(target_company_id, (candidate ->> 'taxPointDate')::date));
  chosen_start := private.reporting_period_start(chosen_period);
  if deadline is not null and (chosen_start + case when chosen_period like '%-Q%' then interval '3 months' else interval '1 month' end)::date > deadline
    then return 'claimed_period_after_deadline'; end if;
  return null;
end;
$$;
revoke all on function private.document_eligibility_error(uuid, uuid, jsonb, text) from public, anon, authenticated, service_role;

-- Recheck the actual saved payload being serialized as well as live issues.
-- Archived byte reads deliberately retain their original separate interface.
alter function private.create_vat_report_artifact(uuid, uuid, timestamptz, text, text, text, text, jsonb, text, text)
  rename to create_vat_report_artifact_before_deadline;
create function private.create_vat_report_artifact(
  target_company_id uuid, target_vat_report_id uuid, target_report_generated_at timestamptz,
  target_format text, target_kind text, target_file_name text, target_xml_base64 text,
  target_resolved_details jsonb, target_schema_version text, target_serializer_version text
)
returns uuid language plpgsql security definer set search_path = '' as $$
declare report public.vat_report;
begin
  perform 1 from public.company c where c.id = target_company_id and private.can_access_company(c.id, c.organization_id) for update;
  if not found then raise insufficient_privilege; end if;
  select * into report from public.vat_report where id = target_vat_report_id and company_id = target_company_id for share;
  if not found then raise insufficient_privilege; end if;
  perform id from public.source_file where company_id = target_company_id order by id for share;
  perform id from public.document where company_id = target_company_id order by id for share;
  if private.reporting_period_claim_issues(target_company_id, report.period) <> '[]'::jsonb
    or exists (select 1 from jsonb_array_elements(report.documents) item
      where item ->> 'status' = 'approved'
        and private.document_eligibility_error(target_company_id, (item ->> 'id')::uuid, item -> 'payload', item ->> 'claimedReportingPeriod') is not null) then
    raise exception 'resolve claim eligibility before a new XML export' using errcode = 'P0001', hint = 'claim_eligibility_unresolved';
  end if;
  return private.create_vat_report_artifact_before_deadline(target_company_id, target_vat_report_id, target_report_generated_at,
    target_format, target_kind, target_file_name, target_xml_base64, target_resolved_details || jsonb_build_object('claimEvaluatedOn', private.current_business_date()), target_schema_version, target_serializer_version);
end;
$$;
revoke all on function private.create_vat_report_artifact(uuid, uuid, timestamptz, text, text, text, text, jsonb, text, text) from public, anon, authenticated, service_role;

-- Remove the obsolete upper bound from the installed delegate; the outer
-- eligibility guard remains the authority, retaining review/lock/audit semantics.
CREATE OR REPLACE FUNCTION public.update_document_reporting_before_claim_eligibility(target_document_id uuid, new_claimed_reporting_period text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $$
declare
  doc public.document;
  payload jsonb;
  tax_point_date date;
  assigned_period text;
  claimed_start date;
begin
  select * into doc from public.document where id = target_document_id;
  if not found or not private.can_access_company(doc.company_id, doc.organization_id) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  perform 1 from public.company where id = doc.company_id for update;
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

-- Never change a pre-upgrade effective assignment across an existing lock.
do $$
begin
  if exists (select 1 from public.vat_report_document d
    where d.payload ->> 'direction' = 'incoming' and d.claimed_reporting_period is not null
      and private.reporting_period_for_date(d.company_id, private.reporting_period_start(d.claimed_reporting_period)) = d.claimed_reporting_period
      and private.reporting_period_start(d.claimed_reporting_period) > private.reporting_period_start(private.document_reporting_period(d.company_id, d.payload ->> 'direction', d.payload ->> 'taxPointDate', null))
      and private.document_reporting_period(d.company_id, d.payload ->> 'direction', d.payload ->> 'taxPointDate', d.claimed_reporting_period) is distinct from d.claimed_reporting_period
      and (private.is_reporting_period_locked(d.company_id, d.claimed_reporting_period)
        or private.is_reporting_period_locked(d.company_id, private.document_reporting_period(d.company_id, d.payload ->> 'direction', d.payload ->> 'taxPointDate', d.claimed_reporting_period)))) then
    raise exception 'Unlock and resolve legacy assignments before upgrading' using errcode = 'P0001', hint = 'locked_legacy_deferred_claim';
  end if;
end;
$$;
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
    and claimed_start > private.reporting_period_start(assigned_period) then
    return document_claimed_reporting_period;
  end if;
  return assigned_period;
end;
$$;

-- Stamp the authoritative transaction date, overriding caller-supplied metadata.
create or replace function public.save_vat_report(target_company_id uuid, target_period text, expected_documents jsonb, computed_result jsonb)
returns uuid language plpgsql security definer set search_path = '' as $$
begin
  perform 1 from public.company c where c.id = target_company_id and private.can_access_company(c.id, c.organization_id) for update;
  if not found then raise insufficient_privilege; end if;
  perform id from public.source_file where company_id = target_company_id order by id for share;
  perform id from public.document where company_id = target_company_id order by id for share;
  if private.reporting_period_claim_issues(target_company_id, target_period) <> '[]'::jsonb then
    raise exception 'resolve Document claim eligibility before new preparation' using errcode = 'P0001', hint = 'claim_eligibility_unresolved';
  end if;
  return public.save_vat_report_before_claim_eligibility(target_company_id, target_period, expected_documents, computed_result || jsonb_build_object('claimEvaluatedOn', private.current_business_date()));
end;
$$;

-- Period feasibility does not depend on whether possession was confirmed yet.
create or replace function public.update_document_reporting(target_document_id uuid, new_claimed_reporting_period text)
returns void language plpgsql security definer set search_path = '' as $$
declare doc public.document; candidate jsonb; refusal text; deadline date; claimed_start date;
begin
  select * into doc from public.document where id = target_document_id;
  if not found or not private.can_access_company(doc.company_id, doc.organization_id) then raise insufficient_privilege; end if;
  perform 1 from public.company where id = doc.company_id for update;
  select * into doc from public.document where id = target_document_id for update;
  select payload into candidate from public.extraction_version where document_id = doc.id order by version desc limit 1;
  if private.is_reporting_period_locked(doc.company_id, private.document_reporting_period_for(doc, candidate))
    or private.is_reporting_period_locked(doc.company_id, new_claimed_reporting_period) then
    raise exception 'the Reporting Period is locked' using errcode = 'P0001', hint = 'period_locked';
  end if;
  if doc.status <> 'needs_review' then raise exception 'return the Document to review first' using errcode = 'P0001', hint = 'not_in_review'; end if;
  if new_claimed_reporting_period is not null and candidate ->> 'direction' = 'incoming'
    and not private.ordinary_domestic_claim(candidate) then
    raise exception 'shared deferral is not supported for this Document' using errcode = 'P0001', hint = 'deferred_claim_not_supported';
  end if;
  if new_claimed_reporting_period is not null and private.ordinary_domestic_claim(candidate) then
    deadline := private.claim_last_filing_date(doc.company_id, candidate);
    claimed_start := private.reporting_period_start(new_claimed_reporting_period);
    if private.current_business_date() > deadline then
      raise exception 'claim filing deadline expired' using errcode = 'P0001', hint = 'claim_deadline_expired';
    end if;
    if (claimed_start + case when new_claimed_reporting_period like '%-Q%' then interval '3 months' else interval '1 month' end)::date > deadline then
      raise exception 'ordinary period ends after the claim cutoff' using errcode = 'P0001', hint = 'claimed_period_after_deadline';
    end if;
  end if;
  if candidate #>> '{claimEligibility,confirmed}' = 'true' and private.ordinary_domestic_claim(candidate) then
    refusal := private.document_eligibility_error(doc.company_id, doc.id, candidate, new_claimed_reporting_period);
    if refusal is not null then raise exception 'resolve the chosen claim period' using errcode = 'P0001', hint = refusal; end if;
  end if;
  perform public.update_document_reporting_before_claim_eligibility(target_document_id, new_claimed_reporting_period);
end;
$$;
