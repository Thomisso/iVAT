-- Legacy null actors do not establish human authorship. Only the explicit new
-- automatic action establishes automatic mode; preserve unknown old metadata.
create function public.document_approval_decisions(target_document_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare doc public.document;
begin
  select * into doc from public.document where id = target_document_id;
  if not found or not private.can_access_company(doc.company_id, doc.organization_id) then raise insufficient_privilege; end if;
  return coalesce((select jsonb_agg(jsonb_build_object(
    'mode', case when e.action = 'document.automatically_approved' then 'automatic'
      when e.actor_user_id is not null then 'human' else 'unknown' end,
    'version', e.payload -> 'version', 'occurredAt', e.occurred_at, 'actorUserId', e.actor_user_id) order by e.id)
    from public.audit_event e where e.company_id = doc.company_id and e.organization_id = doc.organization_id
      and e.target_type = 'document' and e.target_id = doc.id and e.action in ('document.approved', 'document.automatically_approved')), '[]'::jsonb);
end;
$$;

revoke all on function public.document_approval_decisions(uuid) from public, anon, authenticated, service_role;
grant execute on function public.document_approval_decisions(uuid) to authenticated;
