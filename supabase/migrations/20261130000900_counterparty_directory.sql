-- A Company owns its directory. Identity constraints deliberately include archived rows.
create table public.counterparty (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organization(id),
  company_id uuid not null,
  name text not null check (length(btrim(name)) between 1 and 255),
  ico text check (ico ~ '^[0-9]{8}$'),
  vat_id text check (vat_id ~ '^[A-Z]{2}[A-Z0-9]{2,14}$'),
  street text not null default '',
  city text not null default '',
  postal_code text not null default '',
  country_code text not null default '' check (country_code = '' or country_code ~ '^[A-Z]{2}$'),
  supplier boolean not null default false,
  customer boolean not null default false,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  foreign key (company_id, organization_id) references public.company(id, organization_id),
  check (supplier or customer),
  unique (company_id, ico),
  unique (company_id, vat_id)
);

create function private.prepare_counterparty()
returns trigger language plpgsql security definer set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    select c.organization_id into new.organization_id from public.company c where c.id = new.company_id;
    if new.organization_id is null or not private.can_access_company(new.company_id, new.organization_id) then
      raise insufficient_privilege;
    end if;
  end if;
  new.name := btrim(new.name);
  new.ico := nullif(regexp_replace(new.ico, '[[:space:]]', '', 'g'), '');
  new.vat_id := nullif(upper(regexp_replace(new.vat_id, '[[:space:]]', '', 'g')), '');
  new.street := btrim(new.street);
  new.city := btrim(new.city);
  new.postal_code := btrim(new.postal_code);
  new.country_code := upper(btrim(new.country_code));
  return new;
end;
$$;
revoke all on function private.prepare_counterparty() from public, anon, authenticated, service_role;
create trigger prepare_counterparty before insert or update on public.counterparty
  for each row execute function private.prepare_counterparty();

alter table public.counterparty enable row level security;
create policy counterparty_read on public.counterparty for select to authenticated
  using (private.can_access_company(company_id, organization_id));
create policy counterparty_edit on public.counterparty for update to authenticated
  using (private.can_access_company(company_id, organization_id))
  with check (private.can_access_company(company_id, organization_id));
create policy counterparty_create on public.counterparty for insert to authenticated
  with check (private.can_access_company(company_id, organization_id));
revoke all on public.counterparty from public, anon, authenticated, service_role;
grant select on public.counterparty to authenticated;
grant insert (company_id, name, ico, vat_id, street, city, postal_code, country_code, supplier, customer)
  on public.counterparty to authenticated;

grant update (name, ico, vat_id, street, city, postal_code, country_code, supplier, customer)
  on public.counterparty to authenticated;

create function private.audit_counterparty()
returns trigger language plpgsql security definer set search_path = ''
as $$
declare
  values_after jsonb := to_jsonb(new) - array['id', 'organization_id', 'company_id', 'created_at'];
  changes jsonb;
begin
  if tg_op = 'INSERT' then
    perform private.record_audit_event('counterparty.created', new.organization_id, new.company_id,
      'counterparty', new.id, values_after);
  else
    select jsonb_object_agg(e.key, jsonb_build_object('from', to_jsonb(old) -> e.key, 'to', e.value))
      into changes from jsonb_each(values_after) e where e.value is distinct from to_jsonb(old) -> e.key;
    if changes is not null then
      perform private.record_audit_event('counterparty.updated', new.organization_id, new.company_id,
        'counterparty', new.id, changes);
    end if;
  end if;
  return new;
end;
$$;
revoke all on function private.audit_counterparty() from public, anon, authenticated, service_role;
create trigger audit_counterparty after insert or update on public.counterparty
  for each row execute function private.audit_counterparty();

-- Invoker rights retain table RLS; SQL substring search treats punctuation literally.
create function public.search_counterparties(target_company_id uuid, search_text text default '', directory_role text default '')
returns setof public.counterparty
language sql stable security invoker set search_path = ''
as $$
  select c.* from public.counterparty c
  where c.company_id = target_company_id and c.archived_at is null
    and (directory_role = '' or (directory_role = 'supplier' and c.supplier) or (directory_role = 'customer' and c.customer))
    and (btrim(search_text) = '' or position(lower(btrim(search_text)) in lower(c.name)) > 0
      or position(regexp_replace(btrim(search_text), '[[:space:]]', '', 'g') in c.ico) > 0
      or position(upper(regexp_replace(btrim(search_text), '[[:space:]]', '', 'g')) in c.vat_id) > 0);
$$;
revoke all on function public.search_counterparties(uuid, text, text) from public, anon, authenticated, service_role;
grant execute on function public.search_counterparties(uuid, text, text) to authenticated;

-- A typed insert boundary omits the Organization column that the trigger derives.
create function public.create_counterparty(
  target_company_id uuid, counterparty_name text, counterparty_ico text, counterparty_vat_id text,
  counterparty_street text, counterparty_city text, counterparty_postal_code text,
  counterparty_country_code text, counterparty_supplier boolean, counterparty_customer boolean
)
returns uuid language sql security invoker set search_path = ''
as $$
  insert into public.counterparty (company_id, name, ico, vat_id, street, city, postal_code, country_code, supplier, customer)
  values (target_company_id, counterparty_name, counterparty_ico, counterparty_vat_id, counterparty_street,
    counterparty_city, counterparty_postal_code, counterparty_country_code, counterparty_supplier, counterparty_customer)
  returning id;
$$;
revoke all on function public.create_counterparty(uuid, text, text, text, text, text, text, text, boolean, boolean)
  from public, anon, authenticated, service_role;
grant execute on function public.create_counterparty(uuid, text, text, text, text, text, text, text, boolean, boolean)
  to authenticated;

-- Directory mutations are part of the same complete Company export boundary.
create trigger counterparty_data_revision
  after insert or update or delete on public.counterparty
  for each row execute function private.bump_company_data_revision();

alter function public.company_export_snapshot(uuid) rename to company_export_snapshot_without_counterparties;
alter function public.company_export_snapshot_without_counterparties(uuid) set schema private;
create function public.company_export_snapshot(target_company_id uuid)
returns jsonb language plpgsql stable security definer set search_path = ''
as $$
declare snapshot jsonb;
begin
  snapshot := private.company_export_snapshot_without_counterparties(target_company_id);
  return snapshot || jsonb_build_object('counterparties', coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', c.id, 'organizationId', c.organization_id, 'companyId', c.company_id,
      'name', c.name, 'ico', c.ico, 'vatId', c.vat_id, 'street', c.street, 'city', c.city,
      'postalCode', c.postal_code, 'countryCode', c.country_code,
      'supplier', c.supplier, 'customer', c.customer, 'archivedAt', c.archived_at, 'createdAt', c.created_at
    ) order by c.created_at, c.id)
    from public.counterparty c where c.company_id = target_company_id
  ), '[]'::jsonb));
end;
$$;
revoke all on function public.company_export_snapshot(uuid), private.company_export_snapshot_without_counterparties(uuid)
  from public, anon, authenticated, service_role;
