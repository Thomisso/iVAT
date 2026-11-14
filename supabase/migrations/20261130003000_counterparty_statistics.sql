-- Financial population is deliberately separate from historical link discovery.
-- One scalar JSON result keeps complete aggregates outside PostgREST's row cap;
-- the bounded drill-down and totals share one statement snapshot and predicate.
create function public.counterparty_statistics(
  target_company_id uuid, target_counterparty_id uuid, date_from date, date_to date,
  trade_direction text, original_currency text, contribution text, page_number integer
)
returns jsonb language plpgsql stable security invoker set search_path = '' as $$
declare result jsonb;
begin
  if not exists (select 1 from public.counterparty where company_id = target_company_id and id = target_counterparty_id) then
    raise insufficient_privilege;
  end if;
  if date_from is null or date_to is null or date_from > date_to
    or trade_direction is null or trade_direction not in ('', 'incoming', 'outgoing')
    or original_currency is null or (original_currency <> 'unknown' and original_currency !~ '^([A-Z]{3})?$')
    or contribution is null or contribution not in ('dated', 'complete', 'missing_amounts', 'missing_date')
    or page_number is null or page_number < 1 then
    raise exception 'invalid statistics filter' using errcode = 'P0001', hint = 'invalid_statistics_filter';
  end if;
  with current_documents as materialized (
    select d.id, v.version, v.payload
    from public.document d
    join lateral (
      select ev.version, ev.payload, ev.counterparty_id from public.extraction_version ev
      where ev.document_id = d.id order by ev.version desc limit 1
    ) v on true
    where d.company_id = target_company_id and d.status = 'approved' and d.superseded_at is null
      and v.counterparty_id = target_counterparty_id
  ), originals as materialized (
    select id as "documentId", version, payload ->> 'documentNumber' as "documentNumber",
      case when payload ->> 'taxPointDate' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
        and pg_catalog.pg_input_is_valid(payload ->> 'taxPointDate', 'date') then payload ->> 'taxPointDate' end as "taxPointDate",
      payload ->> 'direction' as direction,
      case when payload ->> 'currency' ~ '^[A-Z]{3}$' then payload ->> 'currency' end as currency,
      case when payload #>> '{totals,netAmount}' ~ '^-?[0-9]+\.[0-9]{2}$' then (payload #>> '{totals,netAmount}')::numeric end as net,
      case when payload #>> '{totals,vatAmount}' ~ '^-?[0-9]+\.[0-9]{2}$' then (payload #>> '{totals,vatAmount}')::numeric end as vat,
      case when payload #>> '{totals,grossAmount}' ~ '^-?[0-9]+\.[0-9]{2}$' then (payload #>> '{totals,grossAmount}')::numeric end as gross
    from current_documents
  ), population as materialized (
    select *, currency is not null and net is not null and vat is not null and gross is not null as complete
    from originals where (trade_direction = '' or direction = trade_direction)
      and (original_currency = '' or original_currency = 'unknown' and currency is null or currency = original_currency)
  ), dated as materialized (
    select * from population where "taxPointDate" between date_from::text and date_to::text
  ), matching as materialized (
    select * from population where case contribution
      when 'missing_date' then "taxPointDate" is null
      else "taxPointDate" between date_from::text and date_to::text
        and (contribution = 'dated' or contribution = 'complete' and complete or contribution = 'missing_amounts' and not complete)
    end
  ), groups as (
    select direction, currency, count(*) as "documentCount", count(*) filter (where complete) as "amountCount",
      count(*) filter (where not complete) as "missingAmountCount",
      (sum(net) filter (where complete))::text as "netAmount",
      (sum(vat) filter (where complete))::text as "vatAmount",
      (sum(gross) filter (where complete))::text as "grossAmount"
    from dated group by direction, currency order by direction, currency nulls last
  ), entries as (
    select "documentId", version, "documentNumber", "taxPointDate", direction, currency,
      net::text as "netAmount", vat::text as "vatAmount", gross::text as "grossAmount", complete
    from matching order by "taxPointDate" desc nulls last, "documentId"
    limit 50 offset (page_number::bigint - 1) * 50
  )
  select jsonb_build_object(
    'groups', coalesce((select jsonb_agg(to_jsonb(g)) from groups g), '[]'::jsonb),
    'total', (select count(*) from matching),
    'missingDateCount', (select count(*) from population where "taxPointDate" is null),
    'missingAmountCount', (select count(*) from dated where not complete),
    'entries', coalesce((select jsonb_agg(to_jsonb(e)) from entries e), '[]'::jsonb)
  ) into result;
  return result;
end;
$$;
revoke all on function public.counterparty_statistics(uuid, uuid, date, date, text, text, text, integer) from public, anon, service_role;
grant execute on function public.counterparty_statistics(uuid, uuid, date, date, text, text, text, integer) to authenticated;
