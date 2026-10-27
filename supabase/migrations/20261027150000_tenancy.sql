-- Tenancy model (ADR-0001): Organization → Company, with Memberships carrying a Role.
-- Every tenant-owned row carries organization_id (and company_id where applicable);
-- RLS policies derive access from the authenticated user's Memberships.

create table public.organization (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(trim(name)) > 0),
  created_at timestamptz not null default now()
);

create table public.company (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organization (id),
  name text not null check (length(trim(name)) > 0),
  ico text not null check (ico ~ '^[0-9]{8}$'),
  vat_id text not null check (vat_id ~ '^CZ[0-9]{8,10}$'),
  street text not null check (length(trim(street)) > 0),
  city text not null check (length(trim(city)) > 0),
  postal_code text not null check (postal_code ~ '^[0-9]{3} [0-9]{2}$'),
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  unique (id, organization_id),
  unique (organization_id, ico)
);

create type public.membership_role as enum ('administrator', 'user');

-- A Membership without company_id is Organization-level; only Administrators exist there.
create table public.membership (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  organization_id uuid not null references public.organization (id),
  company_id uuid,
  role public.membership_role not null,
  created_at timestamptz not null default now(),
  foreign key (company_id, organization_id) references public.company (id, organization_id),
  check (company_id is not null or role = 'administrator'),
  unique nulls not distinct (user_id, organization_id, company_id)
);

create index membership_user_id_idx on public.membership (user_id);
create index membership_company_id_idx on public.membership (company_id);

-- Access predicates. SECURITY DEFINER so policies on membership don't recurse.

create function private.is_organization_administrator(target_organization_id uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.membership m
    where m.user_id = auth.uid()
      and m.organization_id = target_organization_id
      and m.company_id is null
      and m.role = 'administrator'
  );
$$;

create function private.is_organization_member(target_organization_id uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.membership m
    where m.user_id = auth.uid() and m.organization_id = target_organization_id
  );
$$;

-- An Organization Administrator has access to all of the Organization's Companies.
create function private.can_access_company(target_company_id uuid, target_organization_id uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select private.is_organization_administrator(target_organization_id)
    or exists (
      select 1 from public.membership m
      where m.user_id = auth.uid() and m.company_id = target_company_id
    );
$$;

revoke execute on function private.is_organization_administrator, private.is_organization_member,
  private.can_access_company from public;
grant execute on function private.is_organization_administrator(uuid) to authenticated;
grant execute on function private.is_organization_member(uuid) to authenticated;
grant execute on function private.can_access_company(uuid, uuid) to authenticated;

-- Privileges: anon gets nothing; authenticated gets only what the application uses.

revoke all on public.organization, public.company, public.membership from anon, authenticated;
grant select on public.organization to authenticated;
grant select, insert (organization_id, name, ico, vat_id, street, city, postal_code) on public.company to authenticated;
grant select on public.membership to authenticated;

alter table public.organization enable row level security;
alter table public.company enable row level security;
alter table public.membership enable row level security;

create policy "members read their organization" on public.organization
  for select to authenticated
  using (private.is_organization_member(id));

create policy "members read accessible companies" on public.company
  for select to authenticated
  using (private.can_access_company(id, organization_id));

create policy "organization administrators create companies" on public.company
  for insert to authenticated
  with check (private.is_organization_administrator(organization_id));

create policy "users read own memberships; organization administrators read all" on public.membership
  for select to authenticated
  using (user_id = auth.uid() or private.is_organization_administrator(organization_id));

create policy "organization administrators read the audit log" on public.audit_event
  for select to authenticated
  using (private.is_organization_administrator(organization_id));

-- Self-service sign-up creates the user's Organization and Administrator Membership.

create function private.handle_new_user()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  new_organization_id uuid;
begin
  insert into public.organization (name)
  values (coalesce(nullif(trim(new.raw_user_meta_data ->> 'organization_name'), ''), new.email))
  returning id into new_organization_id;

  insert into public.membership (user_id, organization_id, role)
  values (new.id, new_organization_id, 'administrator');

  perform private.record_audit_event(
    'user.signed_up', new_organization_id, null, 'user', new.id,
    jsonb_build_object('email', new.email, 'organization_name',
      (select name from public.organization where id = new_organization_id)),
    new.id
  );

  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function private.handle_new_user();

create function private.audit_company_created()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  perform private.record_audit_event(
    'company.created', new.organization_id, new.id, 'company', new.id,
    to_jsonb(new) - 'organization_id' - 'id' - 'created_by' - 'created_at'
  );
  return new;
end;
$$;

create trigger company_created_audit
  after insert on public.company
  for each row execute function private.audit_company_created();
