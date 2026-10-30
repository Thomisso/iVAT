-- Internal tenant-owned ledgers are default-deny under RLS as well as grants.
-- Only the owning security-definer operations read or write these rows.
alter table private.deleted_source_file_object enable row level security;
alter table private.company_ai_processing_consumption add column organization_id uuid;
update private.company_ai_processing_consumption consumption
set organization_id = company.organization_id
from public.company company
where company.id = consumption.company_id;
alter table private.company_ai_processing_consumption
  alter column organization_id set not null,
  add foreign key (company_id, organization_id)
    references public.company (id, organization_id) on delete cascade;
alter table private.company_ai_processing_consumption enable row level security;

create or replace function private.record_ai_processing_consumption()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if new.author_user_id is null then
    insert into private.company_ai_processing_consumption as consumption (company_id, organization_id, used)
    values (new.company_id, new.organization_id, 1)
    on conflict (company_id) do update set used = consumption.used + 1;
  end if;
  return new;
end;
$$;

-- Enforce the Rate Breakdown totals at every approval transition, even when a
-- caller supplied stale or incomplete findings. Gross totals remain warnings.
create function private.refuse_inconsistent_totals_approval()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  payload jsonb;
  line jsonb;
  net numeric := 0;
  vat numeric := 0;
  amount_text text;
begin
  if new.status <> 'approved' or old.status = 'approved' then
    return new;
  end if;
  select version.payload into payload
  from public.extraction_version version
  where version.document_id = new.id
  order by version.version desc limit 1;

  for line in select value from jsonb_array_elements(payload -> 'rateBreakdown') loop
    if coalesce(line ->> 'netAmount', '') !~ '^-?[0-9]+\.[0-9]{2}$'
      or coalesce(line ->> 'vatAmount', '') !~ '^-?[0-9]+\.[0-9]{2}$' then
      return new;
    end if;
    net := net + (line ->> 'netAmount')::numeric;
    vat := vat + (line ->> 'vatAmount')::numeric;
  end loop;

  amount_text := payload -> 'totals' ->> 'netAmount';
  if amount_text ~ '^-?[0-9]+\.[0-9]{2}$' then
    if abs(amount_text::numeric - net) > 0.02 then
      raise exception 'net total disagrees with the Rate Breakdown'
        using errcode = 'P0001', hint = 'rate_breakdown_totals_mismatch';
    end if;
  end if;
  amount_text := payload -> 'totals' ->> 'vatAmount';
  if amount_text ~ '^-?[0-9]+\.[0-9]{2}$' then
    if abs(amount_text::numeric - vat) > 0.02 then
      raise exception 'VAT total disagrees with the Rate Breakdown'
        using errcode = 'P0001', hint = 'rate_breakdown_totals_mismatch';
    end if;
  end if;
  return new;
end;
$$;
revoke execute on function private.refuse_inconsistent_totals_approval() from public;
create trigger document_totals_before_approval
  before update of status on public.document
  for each row execute function private.refuse_inconsistent_totals_approval();

-- Historical immutable findings follow the same warning rule in database readiness.
create or replace function private.reporting_period_readiness_documents(
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
    (select coalesce(jsonb_agg(
      case when finding ->> 'code' = 'total_gross_amount_mismatch'
        then finding || '{"severity":"warning"}'::jsonb
        else finding end order by position
    ), '[]'::jsonb)
    from jsonb_array_elements(coalesce(version.findings, '[]'::jsonb))
      with ordinality as entry(finding, position)),
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
