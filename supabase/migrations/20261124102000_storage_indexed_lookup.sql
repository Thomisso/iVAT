-- Match the original canonical UUID text spelling, then use the existing UUID
-- index instead of scanning every Company for each object in Storage listings.
create or replace function private.can_access_company_object(object_name text)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.company c
    where c.id = case
      when strpos(object_name, '/') > 0
        and split_part(object_name, '/', 1) ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      then split_part(object_name, '/', 1)::uuid
    end
      and private.can_access_company(c.id, c.organization_id)
  );
$$;

-- Inspection historically also accepts a rootless canonical Company UUID.
-- Keep that distinct behavior while applying the same indexed lookup.
create or replace function private.can_inspect_company_object(object_name text)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.company c
    where c.id = case
      when split_part(object_name, '/', 1) ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      then split_part(object_name, '/', 1)::uuid
    end
      and private.can_inspect_company(c.id, c.organization_id)
  );
$$;
