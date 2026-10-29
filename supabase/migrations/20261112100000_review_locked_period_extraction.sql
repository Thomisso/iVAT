-- A newly uploaded Document is not yet part of a Reporting Period. Preserve
-- its first successful AI Extraction even when the extracted date indicates a
-- locked period, then let review explain the lock. Every later Extraction or
-- user-authored change remains protected by the Period Lock (ADR-0007).

create or replace function private.refuse_locked_extraction_version()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  doc public.document;
  old_period text;
  new_period text;
  initial_ai_extraction boolean;
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
  if (old_period is not null and private.is_reporting_period_locked(new.company_id, old_period))
    or (new_period is not null
      and private.is_reporting_period_locked(new.company_id, new_period)
      and not initial_ai_extraction) then
    raise exception 'the Reporting Period is locked'
      using errcode = 'P0001', hint = 'period_locked';
  end if;
  return new;
end;
$$;

-- record_ai_extraction changes only the processing status after inserting the
-- first version. Allow that one transition so the Document reaches review;
-- other changes to a Document assigned to a locked period stay refused.
create or replace function private.refuse_locked_document_change()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  payload jsonb;
  old_period text;
  new_period text;
  finishes_initial_extraction boolean := false;
begin
  select version.payload into payload
  from public.extraction_version version
  where version.document_id = old.id
  order by version.version desc
  limit 1;
  old_period := private.document_reporting_period_for(old, payload);
  if tg_op = 'DELETE' then
    new_period := old_period;
  else
    new_period := private.document_reporting_period_for(new, payload);
    finishes_initial_extraction := old.status in ('uploaded', 'processing')
      and new.status = 'needs_review'
      and (to_jsonb(old) - 'status') = (to_jsonb(new) - 'status')
      and (
        select count(*) = 1
        from public.extraction_version version
        where version.document_id = old.id
          and version.author_user_id is null
          and version.extraction_request_id = old.extraction_request_id
      );
  end if;
  if ((old_period is not null and private.is_reporting_period_locked(old.company_id, old_period))
    or (new_period is not null and private.is_reporting_period_locked(old.company_id, new_period)))
    and not finishes_initial_extraction then
    raise exception 'the Reporting Period is locked'
      using errcode = 'P0001', hint = 'period_locked';
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;
