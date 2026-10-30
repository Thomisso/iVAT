-- Exports keep the current exclusion receipt alongside the preserved Versions.
alter function public.company_export_snapshot(uuid) rename to company_export_snapshot_without_exclusions;
alter function public.company_export_snapshot_without_exclusions(uuid) set schema private;
create function public.company_export_snapshot(target_company_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare snapshot jsonb;
begin
  snapshot := private.company_export_snapshot_without_exclusions(target_company_id);
  return jsonb_set(snapshot, '{documents}', coalesce((
    select jsonb_agg(entry.value || case when document.exclusion_reason is not null then
      jsonb_build_object('exclusion', jsonb_build_object(
        'reason', document.exclusion_reason, 'at', document.excluded_at, 'userId', document.excluded_by
      )) else '{}'::jsonb end order by entry.ordinality)
    from jsonb_array_elements(snapshot -> 'documents') with ordinality entry(value, ordinality)
    join public.document document on document.id = (entry.value ->> 'id')::uuid
      and document.company_id = target_company_id
  ), '[]'::jsonb));
end;
$$;
revoke all on function public.company_export_snapshot(uuid), private.company_export_snapshot_without_exclusions(uuid) from public, anon, authenticated, service_role;
