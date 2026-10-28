-- Company reporting settings (#27): legal/natural person identity and an
-- effective-dated filing-frequency history. Writes are atomic RPCs because a
-- Company and its initial/current frequency must never drift apart.

create type public.person_type as enum ('legal', 'natural');
create type public.filing_frequency as enum ('monthly', 'quarterly');

alter table public.company
  add column person_type public.person_type not null default 'legal';

create table public.company_filing_frequency (
  company_id uuid not null,
  organization_id uuid not null,
  frequency public.filing_frequency not null,
  effective_from date not null,
  created_at timestamptz not null default now(),
  primary key (company_id, effective_from),
  foreign key (company_id, organization_id)
    references public.company (id, organization_id) on delete cascade
);

insert into public.company_filing_frequency
  (company_id, organization_id, frequency, effective_from)
select id, organization_id, 'monthly', created_at::date
from public.company;

create index company_filing_frequency_organization_id_idx
  on public.company_filing_frequency (organization_id, company_id, effective_from desc);

revoke all on public.company_filing_frequency from anon, authenticated;
grant select on public.company_filing_frequency to authenticated;

alter table public.company_filing_frequency enable row level security;

create policy "members read accessible Company filing frequencies"
  on public.company_filing_frequency
  for select to authenticated
  using (private.can_access_company(company_id, organization_id));

create function private.can_administrate_company(
  target_company_id uuid,
  target_organization_id uuid
)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select private.is_organization_administrator(target_organization_id)
    or exists (
      select 1
      from public.membership m
      where m.user_id = auth.uid()
        and m.organization_id = target_organization_id
        and m.company_id = target_company_id
        and m.role = 'administrator'
    );
$$;

revoke execute on function private.can_administrate_company(uuid, uuid) from public;
grant execute on function private.can_administrate_company(uuid, uuid) to authenticated;

create function public.create_company(
  target_organization_id uuid,
  company_name text,
  company_ico text,
  company_vat_id text,
  company_street text,
  company_city text,
  company_postal_code text,
  company_person_type public.person_type,
  initial_filing_frequency public.filing_frequency,
  filing_frequency_effective_from date
)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  new_company_id uuid;
begin
  if not private.is_organization_administrator(target_organization_id) then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  insert into public.company (
    organization_id, name, ico, vat_id, street, city, postal_code,
    person_type, created_by
  ) values (
    target_organization_id, company_name, company_ico, company_vat_id,
    company_street, company_city, company_postal_code, company_person_type,
    auth.uid()
  ) returning id into new_company_id;

  insert into public.company_filing_frequency (
    company_id, organization_id, frequency, effective_from
  ) values (
    new_company_id, target_organization_id, initial_filing_frequency,
    filing_frequency_effective_from
  );

  return new_company_id;
end;
$$;

revoke execute on function public.create_company(
  uuid, text, text, text, text, text, text, public.person_type,
  public.filing_frequency, date
) from public;
grant execute on function public.create_company(
  uuid, text, text, text, text, text, text, public.person_type,
  public.filing_frequency, date
) to authenticated;

-- Company creation now goes through the atomic function above.
revoke insert on public.company from authenticated;

create function public.update_company(
  target_company_id uuid,
  company_name text,
  company_ico text,
  company_vat_id text,
  company_street text,
  company_city text,
  company_postal_code text,
  company_person_type public.person_type,
  new_filing_frequency public.filing_frequency,
  filing_frequency_effective_from date
)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  target public.company;
begin
  select * into target
  from public.company
  where id = target_company_id
  for update;

  if not found
    or not private.can_administrate_company(target.id, target.organization_id)
  then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  update public.company
  set name = company_name,
      ico = company_ico,
      vat_id = company_vat_id,
      street = company_street,
      city = company_city,
      postal_code = company_postal_code,
      person_type = company_person_type
  where id = target.id;

  insert into public.company_filing_frequency (
    company_id, organization_id, frequency, effective_from
  ) values (
    target.id, target.organization_id, new_filing_frequency,
    filing_frequency_effective_from
  )
  on conflict (company_id, effective_from) do update
    set frequency = excluded.frequency
    where company_filing_frequency.frequency is distinct from excluded.frequency;
end;
$$;

revoke execute on function public.update_company(
  uuid, text, text, text, text, text, text, public.person_type,
  public.filing_frequency, date
) from public;
grant execute on function public.update_company(
  uuid, text, text, text, text, text, text, public.person_type,
  public.filing_frequency, date
) to authenticated;

create function private.audit_company_updated()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  changes jsonb;
begin
  changes := jsonb_strip_nulls(jsonb_build_object(
    'name', case when old.name is distinct from new.name
      then jsonb_build_object('from', old.name, 'to', new.name) end,
    'ico', case when old.ico is distinct from new.ico
      then jsonb_build_object('from', old.ico, 'to', new.ico) end,
    'vat_id', case when old.vat_id is distinct from new.vat_id
      then jsonb_build_object('from', old.vat_id, 'to', new.vat_id) end,
    'street', case when old.street is distinct from new.street
      then jsonb_build_object('from', old.street, 'to', new.street) end,
    'city', case when old.city is distinct from new.city
      then jsonb_build_object('from', old.city, 'to', new.city) end,
    'postal_code', case when old.postal_code is distinct from new.postal_code
      then jsonb_build_object('from', old.postal_code, 'to', new.postal_code) end,
    'person_type', case when old.person_type is distinct from new.person_type
      then jsonb_build_object('from', old.person_type, 'to', new.person_type) end
  ));
  if changes <> '{}'::jsonb then
    perform private.record_audit_event(
      'company.updated', new.organization_id, new.id, 'company', new.id, changes
    );
  end if;
  return new;
end;
$$;

create trigger company_updated_audit
  after update on public.company
  for each row execute function private.audit_company_updated();

create function private.audit_company_filing_frequency_changed()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  perform private.record_audit_event(
    'company.filing_frequency_changed', new.organization_id, new.company_id,
    'company', new.company_id,
    jsonb_build_object(
      'frequency', new.frequency,
      'effective_from', new.effective_from
    )
  );
  return new;
end;
$$;

create trigger company_filing_frequency_changed_audit
  after insert or update on public.company_filing_frequency
  for each row execute function private.audit_company_filing_frequency_changed();
