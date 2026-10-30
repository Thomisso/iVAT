-- AI usage cost (#128). The SuperAdmin prices each model of an AI
-- Configuration per one million input and output tokens. Every AI usage event
-- stores its cost when it is recorded: the provider-reported cost when present,
-- otherwise the cost from the prices in force, otherwise null (unknown). Later
-- price changes never touch recorded events.

create table public.ai_model_price (
  configuration_id uuid not null references public.ai_configuration (id) on delete cascade,
  model text not null check (length(trim(model)) > 0),
  input_price_per_million_usd numeric not null check (input_price_per_million_usd >= 0),
  output_price_per_million_usd numeric not null check (output_price_per_million_usd >= 0),
  updated_at timestamptz not null default now(),
  updated_by uuid,
  primary key (configuration_id, model)
);

revoke all on public.ai_model_price from anon, authenticated, service_role;
alter table public.ai_model_price enable row level security;

alter table public.ai_usage_event
  add column ai_configuration_id uuid references public.ai_configuration (id) on delete set null,
  add column cost_usd numeric check (cost_usd >= 0);

create index ai_usage_event_created_idx on public.ai_usage_event (created_at);

-- Replaces every price of the named models in one step. A model whose input
-- and output prices are both null loses its price.
create function public.set_ai_model_prices(target_configuration_id uuid, prices jsonb)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  configuration public.ai_configuration;
  price jsonb;
  price_model text;
  input_price numeric;
  output_price numeric;
begin
  if not private.can_administrate_platform() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select * into configuration
  from public.ai_configuration
  where id = target_configuration_id
  for update;
  if not found then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if jsonb_typeof(prices) <> 'array' then
    raise exception 'invalid price' using errcode = 'P0001', hint = 'invalid_price';
  end if;

  for price in select value from jsonb_array_elements(prices) loop
    price_model := price ->> 'model';
    if price_model is null
      or price_model not in (configuration.split_model, configuration.extract_model) then
      raise exception 'unknown model' using errcode = 'P0001', hint = 'unknown_model';
    end if;
    if jsonb_typeof(price -> 'inputPricePerMillion') not in ('number', 'null')
      or jsonb_typeof(price -> 'outputPricePerMillion') not in ('number', 'null') then
      raise exception 'invalid price' using errcode = 'P0001', hint = 'invalid_price';
    end if;
    input_price := (price ->> 'inputPricePerMillion')::numeric;
    output_price := (price ->> 'outputPricePerMillion')::numeric;
    if input_price is null and output_price is null then
      delete from public.ai_model_price
      where configuration_id = configuration.id and model = price_model;
    elsif input_price is null or output_price is null or input_price < 0 or output_price < 0 then
      raise exception 'invalid price' using errcode = 'P0001', hint = 'invalid_price';
    else
      insert into public.ai_model_price (
        configuration_id, model, input_price_per_million_usd, output_price_per_million_usd, updated_by
      ) values (configuration.id, price_model, input_price, output_price, auth.uid())
      on conflict (configuration_id, model) do update set
        input_price_per_million_usd = excluded.input_price_per_million_usd,
        output_price_per_million_usd = excluded.output_price_per_million_usd,
        updated_at = now(),
        updated_by = excluded.updated_by;
    end if;
  end loop;

  perform private.record_ai_configuration_audit_event(
    'ai_configuration.prices_changed',
    configuration.id,
    jsonb_build_object('prices', prices)
  );
end;
$$;

revoke execute on function public.set_ai_model_prices(uuid, jsonb) from public, anon;
grant execute on function public.set_ai_model_prices(uuid, jsonb) to authenticated;

-- The models each AI Configuration names, with their prices. Kept apart from
-- list_ai_configurations, which stays free of model names.
create function public.list_ai_model_prices()
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
begin
  if not private.can_administrate_platform() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'configurationId', configuration.id,
      'models', (
        select jsonb_agg(jsonb_build_object(
          'model', models.model,
          'inputPricePerMillion', price.input_price_per_million_usd,
          'outputPricePerMillion', price.output_price_per_million_usd
        ) order by models.model)
        from (
          select configuration.split_model as model
          union
          select configuration.extract_model
        ) models
        left join public.ai_model_price price
          on price.configuration_id = configuration.id and price.model = models.model
      )
    ) order by configuration.label, configuration.id)
    from public.ai_configuration configuration
  ), '[]'::jsonb);
end;
$$;

revoke execute on function public.list_ai_model_prices() from public, anon;
grant execute on function public.list_ai_model_prices() to authenticated;

drop function public.record_ai_usage(uuid, uuid, text, text, text, bigint, bigint, text, uuid);

-- The price of the call is the price of the model the configuration names for
-- the operation, so a provider answering with a dated model version is still priced.
create function public.record_ai_usage(
  target_organization_id uuid,
  target_company_id uuid,
  target_configuration_id uuid,
  target_provider text,
  target_model text,
  target_operation text,
  target_input_tokens bigint,
  target_output_tokens bigint,
  target_job_name text,
  target_job_id uuid,
  target_provider_cost_usd numeric default null
)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  computed_cost numeric;
begin
  select target_input_tokens * price.input_price_per_million_usd / 1000000
    + target_output_tokens * price.output_price_per_million_usd / 1000000
  into computed_cost
  from public.ai_configuration configuration
  join public.ai_model_price price
    on price.configuration_id = configuration.id
   and price.model = case target_operation
     when 'split' then configuration.split_model
     else configuration.extract_model
   end
  where configuration.id = target_configuration_id;

  insert into public.ai_usage_event (
    organization_id, company_id, ai_configuration_id, provider, model, operation,
    input_tokens, output_tokens, job_name, job_target_id, cost_usd
  ) values (
    target_organization_id, target_company_id, target_configuration_id, target_provider,
    target_model, target_operation, target_input_tokens, target_output_tokens,
    target_job_name, target_job_id, coalesce(target_provider_cost_usd, computed_cost)
  );
end;
$$;

revoke execute on function public.record_ai_usage(uuid, uuid, uuid, text, text, text, bigint, bigint, text, uuid, numeric)
  from public, anon, authenticated;
grant execute on function public.record_ai_usage(uuid, uuid, uuid, text, text, text, bigint, bigint, text, uuid, numeric)
  to service_role;

drop function public.list_platform_ai_usage(date, date);

-- Platform AI usage between two calendar days in Prague (both inclusive), filtered and
-- summed by one dimension. Cost sums only known costs; events with an unknown
-- cost are counted instead, and a group whose every cost is unknown has a null cost.
create function public.list_platform_ai_usage(
  period_from date,
  period_to date,
  group_by text,
  target_organization_id uuid default null,
  target_company_id uuid default null,
  target_configuration_id uuid default null,
  target_model text default null,
  target_operation text default null
)
returns table (
  group_key text,
  group_label text,
  requests bigint,
  input_tokens bigint,
  output_tokens bigint,
  cost_usd numeric,
  unknown_cost_events bigint
)
language plpgsql stable security definer set search_path = ''
as $$
begin
  if not private.can_administrate_platform() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if period_to < period_from then
    raise exception 'invalid period' using errcode = 'P0001', hint = 'invalid_period';
  end if;
  if group_by not in ('organization', 'company', 'ai_configuration', 'model', 'operation', 'month') then
    raise exception 'invalid grouping' using errcode = 'P0001', hint = 'invalid_grouping';
  end if;
  return query
    with grouped as (
      select
        case group_by
          when 'organization' then e.organization_id::text
          when 'company' then e.company_id::text
          when 'ai_configuration' then e.ai_configuration_id::text
          when 'model' then e.model
          when 'operation' then e.operation
          else to_char(e.created_at at time zone 'Europe/Prague', 'YYYY-MM')
        end as key,
        case group_by
          when 'organization' then o.name
          when 'company' then o.name || ' · ' || c.name
          when 'ai_configuration' then configuration.label
          when 'model' then e.model
          when 'operation' then e.operation
          else to_char(e.created_at at time zone 'Europe/Prague', 'YYYY-MM')
        end as label,
        e.requests, e.input_tokens, e.output_tokens, e.cost_usd
      from public.ai_usage_event e
      join public.organization o on o.id = e.organization_id
      join public.company c on c.id = e.company_id
      left join public.ai_configuration configuration on configuration.id = e.ai_configuration_id
      where e.created_at >= (period_from::timestamp at time zone 'Europe/Prague')
        and e.created_at < ((period_to + 1)::timestamp at time zone 'Europe/Prague')
        and (target_organization_id is null or e.organization_id = target_organization_id)
        and (target_company_id is null or e.company_id = target_company_id)
        and (target_configuration_id is null or e.ai_configuration_id = target_configuration_id)
        and (target_model is null or e.model = target_model)
        and (target_operation is null or e.operation = target_operation)
    )
    select grouped.key, min(grouped.label),
      sum(grouped.requests)::bigint,
      sum(grouped.input_tokens)::bigint,
      sum(grouped.output_tokens)::bigint,
      sum(grouped.cost_usd),
      count(*) filter (where grouped.cost_usd is null)
    from grouped
    group by grouped.key
    order by min(grouped.label), grouped.key;
end;
$$;

revoke execute on function public.list_platform_ai_usage(date, date, text, uuid, uuid, uuid, text, text)
  from public, anon;
grant execute on function public.list_platform_ai_usage(date, date, text, uuid, uuid, uuid, text, text)
  to authenticated;

-- Distinct models that ever recorded usage, for the platform usage filter.
create function public.list_platform_ai_usage_models()
returns setof text
language plpgsql stable security definer set search_path = ''
as $$
begin
  if not private.can_administrate_platform() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  return query select distinct e.model from public.ai_usage_event e order by 1;
end;
$$;

revoke execute on function public.list_platform_ai_usage_models() from public, anon;
grant execute on function public.list_platform_ai_usage_models() to authenticated;
