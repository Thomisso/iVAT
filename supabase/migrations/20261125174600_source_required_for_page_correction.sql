-- Page correction requires real source pages. NULL source/range comparisons
-- must never let source-independent Documents pass adjacency checks, and
-- workbook row sets retain their separate non-image semantics.
create or replace function private.assert_split_document_correctable(doc public.document)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  assigned_period text;
begin
  if doc.superseded_at is not null or doc.status in ('uploaded', 'processing') then
    raise exception 'the Split is being processed' using errcode = 'P0001', hint = 'not_correctable';
  end if;
  assigned_period := private.document_current_reporting_period(doc.id);
  if assigned_period is not null
    and private.is_reporting_period_locked(doc.company_id, assigned_period) then
    raise exception 'the Reporting Period is locked'
      using errcode = 'P0001', hint = 'period_locked';
  end if;
  if doc.source_file_id is null or doc.first_page is null or doc.last_page is null
    or doc.has_document_image is distinct from true then
    raise exception 'page correction requires real source pages'
      using errcode = 'P0001', hint = 'not_correctable';
  end if;
end;
$$;
revoke execute on function private.assert_split_document_correctable(public.document)
  from public, anon, authenticated, service_role;
