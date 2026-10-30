-- Keep first-folder authorization while allowing the cheap Company ID predicate
-- to precede permission checks in Storage's parameterized listing plans.
create or replace function private.can_access_company_object(object_name text)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.company c
    where c.id::text = case when strpos(object_name, '/') > 0 then split_part(object_name, '/', 1) end
      and private.can_access_company(c.id, c.organization_id)
  );
$$;
