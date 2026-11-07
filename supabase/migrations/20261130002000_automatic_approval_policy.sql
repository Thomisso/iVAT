-- Existing and new Companies retain human review until an Administrator opts in.
alter table public.company add column automatic_approval_enabled boolean not null default false;
grant select (automatic_approval_enabled) on public.company to authenticated;

create function public.set_company_automatic_approval(target_company_id uuid, enabled boolean)
returns void language plpgsql security definer set search_path = '' as $$
declare target public.company;
begin
  select * into target from public.company where id = target_company_id for update;
  if not found or not private.is_company_administrator(target.id, target.organization_id) then
    raise insufficient_privilege;
  end if;
  if enabled is null then raise not_null_violation; end if;
  if target.automatic_approval_enabled is distinct from enabled then
    update public.company set automatic_approval_enabled = enabled where id = target.id;
    perform private.record_audit_event('company.automatic_approval_changed', target.organization_id, target.id,
      'company', target.id, jsonb_build_object('enabled', enabled));
  end if;
end;
$$;
revoke all on function public.set_company_automatic_approval(uuid, boolean) from public, anon, authenticated, service_role;
grant execute on function public.set_company_automatic_approval(uuid, boolean) to authenticated;
