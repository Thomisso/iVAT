-- Human recovery owns the next request generation, independently of AI setup.
alter table public.document
  add column exclusion_reason text,
  add column excluded_at timestamptz,
  add column excluded_by uuid references auth.users(id) on delete set null;
alter table public.document add constraint document_exclusion_reason_length
  check (exclusion_reason is null or length(trim(exclusion_reason)) between 1 and 500);

create function public.start_manual_document_review(target_document_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare doc public.document;
begin
  select * into doc from public.document where id = target_document_id;
  if not found or not private.can_access_company(doc.company_id, doc.organization_id) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  perform 1 from public.company where id = doc.company_id for update;
  select * into doc from public.document where id = target_document_id for update;
  if not found or not private.can_access_company(doc.company_id, doc.organization_id) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if doc.superseded_at is not null or doc.status in ('approved', 'rejected') then
    raise exception 'the Document cannot enter manual review' using errcode = 'P0001', hint = 'not_recoverable';
  end if;
  if doc.status = 'needs_review' then return; end if;
  delete from public.ai_processing_reservation where document_id = doc.id;
  update public.document set status = 'needs_review', extraction_request_id = gen_random_uuid() where id = doc.id;
  perform private.record_audit_event('document.manual_review_started', doc.organization_id, doc.company_id, 'document', doc.id, '{}'::jsonb);
end;
$$;
revoke all on function public.start_manual_document_review(uuid) from public, anon, service_role;
grant execute on function public.start_manual_document_review(uuid) to authenticated;

create or replace function public.correct_document(
  target_document_id uuid,
  based_on_version integer,
  payload jsonb,
  findings jsonb
)
returns integer
language plpgsql security definer set search_path = ''
as $$
declare
  doc public.document;
  current_version integer;
begin
  select * into doc from public.document where id = target_document_id;
  if not found or not private.can_access_company(doc.company_id, doc.organization_id) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  perform 1 from public.company where id = doc.company_id for update;
  select * into doc from public.document where id = target_document_id for update;
  if not found or not private.can_access_company(doc.company_id, doc.organization_id) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if doc.superseded_at is not null then raise exception 'not allowed' using errcode = '42501'; end if;
  if jsonb_typeof(findings) <> 'array' then
    raise exception 'findings must be an array';
  end if;
  if doc.status <> 'needs_review' then
    raise exception 'only a Document in review can be corrected' using errcode = 'P0001', hint = 'not_in_review';
  end if;
  select coalesce(max(v.version), 0) into current_version from public.extraction_version v where v.document_id = doc.id;
  if current_version is distinct from based_on_version then
    raise exception 'the Document has a newer Extraction Version' using errcode = 'P0001', hint = 'stale_version';
  end if;

  insert into public.extraction_version
    (organization_id, company_id, document_id, version, author_user_id, payload, findings)
  values (
    doc.organization_id, doc.company_id, doc.id, current_version + 1,
    auth.uid(), payload, findings
  );

  perform private.record_audit_event(
    'document.corrected', doc.organization_id, doc.company_id, 'document', doc.id,
    jsonb_build_object('version', current_version + 1)
  );
  return current_version + 1;
end;
$$;

revoke execute on function public.correct_document(uuid, integer, jsonb, jsonb)
  from public, anon, service_role;
grant execute on function public.correct_document(uuid, integer, jsonb, jsonb)
  to authenticated;

-- The first human record is preserved for a recovered Document too; approval stays locked.
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

drop function public.reject_document(uuid);
create function public.reject_document(target_document_id uuid, rejection_reason text default null)
returns void language plpgsql security definer set search_path = '' as $$
declare doc public.document;
begin
  select * into doc from public.document where id = target_document_id;
  if not found or not private.can_access_company(doc.company_id, doc.organization_id) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  perform 1 from public.company where id = doc.company_id for update;
  select * into doc from public.document where id = target_document_id for update;
  if not found or not private.can_access_company(doc.company_id, doc.organization_id) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if doc.superseded_at is not null or doc.status in ('approved', 'rejected') then
    raise exception 'the Document cannot be excluded' using errcode = 'P0001', hint = 'not_in_review';
  end if;
  if rejection_reason is null or length(trim(rejection_reason)) not between 1 and 500 then
    raise exception 'a short exclusion reason is required' using errcode = 'P0001', hint = 'exclusion_reason_required';
  end if;
  delete from public.ai_processing_reservation where document_id = doc.id;
  update public.document set status = 'rejected', extraction_request_id = gen_random_uuid(),
    exclusion_reason = trim(rejection_reason), excluded_at = now(), excluded_by = auth.uid()
  where id = doc.id;
  perform private.record_audit_event('document.rejected', doc.organization_id, doc.company_id, 'document', doc.id,
    jsonb_build_object('reason', trim(rejection_reason)));
end;
$$;
revoke all on function public.reject_document(uuid, text) from public, anon, service_role;
grant execute on function public.reject_document(uuid, text) to authenticated;

create function public.restore_document(target_document_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare doc public.document;
begin
  select * into doc from public.document where id = target_document_id;
  if not found or not private.can_access_company(doc.company_id, doc.organization_id) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  perform 1 from public.company where id = doc.company_id for update;
  select * into doc from public.document where id = target_document_id for update;
  if not found or not private.can_access_company(doc.company_id, doc.organization_id) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if doc.superseded_at is not null or doc.status <> 'rejected' then
    raise exception 'only an excluded Document can be restored' using errcode = 'P0001', hint = 'not_rejected';
  end if;
  delete from public.ai_processing_reservation where document_id = doc.id;
  update public.document set status = 'needs_review', extraction_request_id = gen_random_uuid(),
    exclusion_reason = null, excluded_at = null, excluded_by = null where id = doc.id;
  perform private.record_audit_event('document.exclusion_reversed', doc.organization_id, doc.company_id, 'document', doc.id,
    jsonb_build_object('reason', doc.exclusion_reason));
end;
$$;
revoke all on function public.restore_document(uuid) from public, anon, service_role;
grant execute on function public.restore_document(uuid) to authenticated;
