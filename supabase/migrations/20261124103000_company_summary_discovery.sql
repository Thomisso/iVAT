-- A single scalar avoids repeating the Company's RLS scan for every OFFSET
-- page while preserving the exact caller visibility and deterministic order.
create function public.list_company_summaries()
returns jsonb
language sql stable security invoker set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', company.id,
    'organizationId', company.organization_id,
    'name', company.name
  ) order by company.name, company.id), '[]'::jsonb)
  from public.company company;
$$;
revoke execute on function public.list_company_summaries()
  from public, anon, authenticated, service_role;
grant execute on function public.list_company_summaries() to authenticated;
