-- Preserve only the first User Version of a new source-independent Document.
-- Subsequent versions and every mutation of locked work retain normal guards.
create or replace function private.refuse_locked_extraction_version()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  doc public.document;
  old_period text;
  new_period text;
  initial_ai_extraction boolean;
  initial_user_entry boolean;
begin
  select * into doc from public.document where id = new.document_id;
  old_period := private.document_current_reporting_period(doc.id);
  new_period := private.document_reporting_period_for(doc, new.payload);
  initial_ai_extraction := new.author_user_id is null
    and new.extraction_request_id = doc.extraction_request_id
    and doc.status in ('uploaded', 'processing')
    and not exists (
      select 1 from public.extraction_version version
      where version.document_id = doc.id
    );
  initial_user_entry := new.author_user_id = auth.uid()
    and doc.source_file_id is null
    and doc.status = 'needs_review'
    and new.version = 1
    and not exists (
      select 1 from public.extraction_version version where version.document_id = doc.id
    );
  if (old_period is not null and private.is_reporting_period_locked(new.company_id, old_period))
    or (new_period is not null
      and private.is_reporting_period_locked(new.company_id, new_period)
      and not (initial_ai_extraction or initial_user_entry)) then
    raise exception 'the Reporting Period is locked'
      using errcode = 'P0001', hint = 'period_locked';
  end if;
  return new;
end;
$$;
