-- Closed-pilot provisioning: no User, Company, Membership or Invitation is created.
create function public.create_organization(organization_name text)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  normalized_name text;
  organization_id uuid;
begin
  if not private.can_administrate_platform() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  -- Match the whitespace accepted by the form's String.trim(), including NBSP.
  normalized_name := btrim(organization_name, E' \t\n\r\f\v' || U&'\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF');
  if normalized_name is null or normalized_name = '' then
    raise exception 'Organization name is required' using errcode = 'P0001', hint = 'organization_name_required';
  end if;
  insert into public.organization(name) values (normalized_name) returning id into organization_id;
  perform private.record_audit_event(
    'organization.created', organization_id, null, 'organization', organization_id, '{}'::jsonb
  );
  return organization_id;
end;
$$;
revoke execute on function public.create_organization(text) from public, anon;
grant execute on function public.create_organization(text) to authenticated;
