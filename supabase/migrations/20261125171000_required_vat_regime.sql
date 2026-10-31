-- Approval must never imply a reportable classification when the VAT Regime
-- is undetermined, including callers that omitted the application findings.
create function private.refuse_missing_vat_regime_approval()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  current_payload jsonb;
begin
  if new.status <> 'approved' or old.status = 'approved' then
    return new;
  end if;
  select version.payload into current_payload
  from public.extraction_version version
  where version.document_id = new.id
  order by version.version desc limit 1;
  if nullif(current_payload ->> 'proposedVatRegime', '') is null then
    raise exception 'VAT Regime must be set before approval'
      using errcode = 'P0001', hint = 'vat_regime_required';
  end if;
  return new;
end;
$$;
revoke execute on function private.refuse_missing_vat_regime_approval() from public;
create trigger document_vat_regime_before_approval
  before update of status on public.document
  for each row execute function private.refuse_missing_vat_regime_approval();

-- Historical Versions remain immutable; current lists and Finalization apply the new requirement.
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
    d.claimed_reporting_period
  ) as reporting_period,
  c.party ->> 'name' as counterparty_name,
  c.party ->> 'vatId' as counterparty_vat_id,
  c.party ->> 'ico' as counterparty_ico,
  concat_ws(E'\n', c.party ->> 'name', c.party ->> 'vatId', c.party ->> 'ico') as counterparty_search,
  v.payload ->> 'currency' as currency,
  v.payload -> 'totals' ->> 'grossAmount' as gross_amount,
  coalesce(jsonb_array_length(v.findings), 0)
    + case when v.payload is not null
      and nullif(v.payload ->> 'proposedVatRegime', '') is null
      and not exists (
        select 1 from jsonb_array_elements(coalesce(v.findings, '[]'::jsonb)) finding
        where finding ->> 'code' = 'vat_regime_required'
      ) then 1 else 0 end as finding_count,
  (sf.uploaded_at at time zone 'Europe/Prague')::date as import_date,
  d.claimed_reporting_period,
  nullif(v.payload ->> 'proposedVatRegime', '') as proposed_vat_regime
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


-- Readiness summaries count affected Documents, not individual findings. A
-- rejected Document is a resolved exclusion and stays separate from warnings.
create or replace function private.reporting_period_readiness_stats(
  target_company_id uuid,
  target_period text
)
returns jsonb
language sql stable security definer set search_path = ''
as $$
  with classified as (
    select
      document.status,
      document.status <> 'rejected'
        and (
          document.status in (
            'uploaded',
            'waiting_for_allowance',
            'waiting_for_platform',
            'processing',
            'failed',
            'needs_review'
          )
          or nullif(document.payload ->> 'direction', '') is null
          or nullif(document.payload ->> 'proposedVatRegime', '') is null
          or nullif(document.payload ->> 'taxPointDate', '') is null
          or not (
            jsonb_typeof(document.payload -> 'rateBreakdown') = 'array'
            and jsonb_array_length(document.payload -> 'rateBreakdown') > 0
          )
          or nullif(document.payload ->> 'currency', '') is null
          or exists (
            select 1
            from jsonb_array_elements(coalesce(document.findings, '[]'::jsonb)) finding
            where finding ->> 'severity' = 'error'
          )
        ) as has_blocker,
      document.status not in (
        'uploaded',
        'waiting_for_allowance',
        'waiting_for_platform',
        'processing',
        'failed',
        'rejected'
      )
        and exists (
          select 1
          from jsonb_array_elements(coalesce(document.findings, '[]'::jsonb)) finding
          where finding ->> 'severity' = 'warning'
        ) as has_warning
    from private.reporting_period_readiness_documents(
      target_company_id,
      target_period
    ) document
  )
  select jsonb_build_object(
    'blockers', count(*) filter (where has_blocker),
    'warnings', count(*) filter (where has_warning),
    'rejectedDocuments', count(*) filter (where status = 'rejected')
  )
  from classified;
$$;

revoke execute on function private.reporting_period_readiness_stats(uuid, text)
  from public;
