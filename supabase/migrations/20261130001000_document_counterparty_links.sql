-- Each immutable Version retains its own directory reference, including links
-- no longer present on the current Version. A serialized deletion guard protects history.
alter table public.extraction_version add column counterparty_id uuid;
grant select (counterparty_id) on public.extraction_version to authenticated;
-- A mutable directory identity row must not become an implicit FK lock target
-- after Company: its direct identifier UPDATE already holds that row while
-- waiting for Company. Validate links on insert, and protect all history here.
create function private.guard_counterparty_history()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  perform 1 from public.company where id = old.company_id for update;
  if exists (select 1 from public.extraction_version v where v.company_id = old.company_id and v.counterparty_id = old.id) then
    raise foreign_key_violation using message = 'Counterparty is referenced by recorded Documents';
  end if;
  return old;
end;
$$;
revoke all on function private.guard_counterparty_history() from public, anon, authenticated, service_role;
create trigger counterparty_history before delete on public.counterparty
  for each row execute function private.guard_counterparty_history();

create index extraction_version_counterparty_history on public.extraction_version(company_id, counterparty_id, document_id) where counterparty_id is not null;

create function private.document_counterparty_payload(target_company_id uuid, target_document_id uuid, candidate jsonb)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare entry public.counterparty; link_id uuid;
begin
  if candidate -> 'counterpartyLink' is null or candidate -> 'counterpartyLink' = 'null'::jsonb then return candidate - 'counterpartyLink'; end if;
  begin link_id := (candidate #>> '{counterpartyLink,id}')::uuid;
  exception when invalid_text_representation then raise insufficient_privilege; end;
  -- Company serialization protects directory changes. Never lock this tuple:
  -- a direct directory UPDATE owns it before its trigger waits for Company.
  select * into entry from public.counterparty where company_id = target_company_id and id = link_id;
  if not found then raise insufficient_privilege; end if;
  if entry.archived_at is not null and not exists (
    select 1 from public.extraction_version v where v.company_id = target_company_id and v.counterparty_id = entry.id
      and v.document_id = target_document_id
  ) then raise insufficient_privilege; end if;
  return jsonb_set(candidate, '{counterpartyLink}', jsonb_build_object('id', entry.id, 'recorded', jsonb_build_object(
    'name', entry.name, 'ico', entry.ico, 'vatId', entry.vat_id, 'street', nullif(entry.street, ''), 'city', nullif(entry.city, ''),
    'postalCode', nullif(entry.postal_code, ''), 'country', nullif(entry.country_code, ''))));
end;
$$;
revoke all on function private.document_counterparty_payload(uuid, uuid, jsonb) from public, anon, authenticated, service_role;

-- Normalize spacing and identifier formatting, without hiding substantive text.
create function private.counterparty_comparison(value text, field text)
returns text language sql immutable set search_path = '' as $$
  select case when field in ('ico', 'vatId', 'country', 'postalCode')
    then upper(regexp_replace(coalesce(value, ''), '[[:space:] ]+', '', 'g'))
    else btrim(regexp_replace(coalesce(value, ''), '[[:space:] ]+', ' ', 'g')) end;
$$;
revoke all on function private.counterparty_comparison(text, text) from public, anon, authenticated, service_role;
create function private.document_counterparty_findings(candidate jsonb)
returns jsonb language sql immutable set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object('field', side || '.' || field, 'severity', 'warning',
    'code', 'counterparty_directory_difference', 'params', jsonb_build_object(
      'documentValue', coalesce(candidate -> side ->> field, ''),
      'directoryValue', coalesce(candidate #> '{counterpartyLink,recorded}' ->> field, ''))
  ) order by field), '[]'::jsonb)
  from unnest(array['name','ico','vatId','street','city','postalCode','country']) field
  cross join lateral (select case candidate ->> 'direction' when 'incoming' then 'supplier' when 'outgoing' then 'customer' end as side) party
  where side is not null and candidate #> '{counterpartyLink,recorded}' is not null
    and private.counterparty_comparison(candidate -> side ->> field, field)
      is distinct from private.counterparty_comparison(candidate #> '{counterpartyLink,recorded}' ->> field, field);
$$;
revoke all on function private.document_counterparty_findings(jsonb) from public, anon, authenticated, service_role;

create function private.prepare_document_counterparty_link()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  perform 1 from public.company where id = new.company_id for update;
  new.payload := private.document_counterparty_payload(new.company_id, new.document_id, new.payload);
  new.counterparty_id := (new.payload #>> '{counterpartyLink,id}')::uuid;
  new.findings := coalesce((select jsonb_agg(f) from jsonb_array_elements(new.findings) f
    where f ->> 'code' <> 'counterparty_directory_difference'), '[]'::jsonb) || private.document_counterparty_findings(new.payload);
  return new;
end;
$$;

revoke all on function private.prepare_document_counterparty_link() from public, anon, authenticated, service_role;
create trigger extraction_version_counterparty_link before insert on public.extraction_version
  for each row execute function private.prepare_document_counterparty_link();

-- Preparation under real Auth/RLS; final writes re-read under Company lock.
create function public.prepare_document_counterparty(target_company_id uuid, target_document_id uuid, candidate jsonb)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare prepared jsonb;
begin
  if not exists (select 1 from public.company c where c.id = target_company_id
    and c.deleted_at is null and private.can_access_company(c.id, c.organization_id)) then raise insufficient_privilege; end if;
  if target_document_id is not null and not exists (select 1 from public.document d
    where d.id = target_document_id and d.company_id = target_company_id and d.superseded_at is null) then raise insufficient_privilege; end if;
  prepared := private.document_counterparty_payload(target_company_id, target_document_id, candidate);
  return jsonb_build_object('payload', prepared, 'findings', private.document_counterparty_findings(prepared));
end;
$$;
revoke all on function public.prepare_document_counterparty(uuid, uuid, jsonb) from public, anon, service_role;
grant execute on function public.prepare_document_counterparty(uuid, uuid, jsonb) to authenticated;

-- A historical-only link remains discoverable; one row per Document, paginated
-- by the caller with an exact PostgREST count rather than a capped local scan.
create function public.counterparty_documents(target_company_id uuid, target_counterparty_id uuid)
returns table(document_id uuid, version integer, document_number text)
language sql stable security invoker set search_path = '' as $$
  select distinct on (v.document_id) v.document_id, v.version, v.payload ->> 'documentNumber'
  from public.extraction_version v join public.document d on d.id = v.document_id
  where v.company_id = target_company_id and v.counterparty_id = target_counterparty_id and d.superseded_at is null
  order by v.document_id, v.version desc;
$$;
revoke all on function public.counterparty_documents(uuid, uuid) from public, anon, service_role;
grant execute on function public.counterparty_documents(uuid, uuid) to authenticated;

create or replace function private.document_review_data(candidate jsonb)
returns jsonb language sql immutable security definer set search_path = '' as $$
  select coalesce(jsonb_object_agg(key, value), '{}'::jsonb) from jsonb_each(coalesce(candidate, '{}'::jsonb))
  where key = any(array['documentType', 'documentNumber', 'issueDate', 'taxPointDate', 'dueDate', 'direction',
    'supplier', 'customer', 'currency', 'rateBreakdown', 'totals', 'payment', 'proposedVatRegime',
    'reverseChargeCode', 'originalDocumentNumber', 'czkConversion', 'counterpartyLink']);
$$;
revoke all on function private.document_review_data(jsonb) from public, anon, authenticated, service_role;

-- Later source evidence support annotates changed-field provenance here. It
-- always inherits references from the authoritative locked base Version.
create or replace function private.document_manual_review_payload(base jsonb, candidate jsonb)
returns jsonb language sql immutable security definer set search_path = '' as $$
  select (coalesce(base, '{}'::jsonb) - array(select jsonb_object_keys(private.document_review_data(base))) - 'schemaVersion' - 'confidence')
    || private.document_review_data(candidate) || jsonb_build_object('schemaVersion', candidate -> 'schemaVersion');
$$;
revoke all on function private.document_manual_review_payload(jsonb, jsonb) from public, anon, authenticated, service_role;


-- Bind actual directory details and differences inside the final locked transaction.
create or replace function public.save_and_approve_document(
  target_document_id uuid, based_on_version integer, request_id uuid,
  payload jsonb, findings jsonb, submitted_payload jsonb, expected_context jsonb,
  acknowledgement uuid default null
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  approved_version integer;
  doc public.document;
  current_payload jsonb;
  current_version integer;
  current_context jsonb;
  warning_findings jsonb;
  confirmation_id uuid;
begin
  select * into doc from public.document where id = target_document_id;
  if not found or not private.can_access_company(doc.company_id, doc.organization_id) then raise insufficient_privilege; end if;
  perform 1 from public.company where id = doc.company_id for update;
  select * into doc from public.document where id = target_document_id for update;
  if not found or not private.can_access_company(doc.company_id, doc.organization_id) or doc.superseded_at is not null then raise insufficient_privilege; end if;
  if request_id is null or jsonb_typeof(payload) is distinct from 'object' or jsonb_typeof(submitted_payload) is distinct from 'object'
    or jsonb_typeof(findings) is distinct from 'array' then
    raise exception 'invalid review request' using errcode = 'P0001', hint = 'stale_version';
  end if;
  approved_version := public.document_approval_result(target_document_id, request_id, submitted_payload, based_on_version);
  if approved_version is not null then return jsonb_build_object('version', approved_version); end if;
  select v.version, v.payload into current_version, current_payload from public.extraction_version v
    where v.document_id = doc.id order by v.version desc limit 1;
  if coalesce(current_version, 0) is distinct from based_on_version then
    raise exception 'the Document has a newer Extraction Version' using errcode = 'P0001', hint = 'stale_version';
  end if;
  if doc.status <> 'needs_review' then
    raise exception 'only a Document in review can be approved' using errcode = 'P0001', hint = 'not_in_review';
  end if;
  payload := private.document_manual_review_payload(current_payload, payload);
  payload := private.document_counterparty_payload(doc.company_id, doc.id, payload);
  findings := coalesce((select jsonb_agg(f) from jsonb_array_elements(findings) f
    where f ->> 'code' <> 'counterparty_directory_difference'), '[]'::jsonb) || private.document_counterparty_findings(payload);
  if private.is_reporting_period_locked(doc.company_id, private.document_current_reporting_period(doc.id))
    or private.is_reporting_period_locked(doc.company_id, private.document_reporting_period_for(doc, payload)) then
    raise exception 'the Reporting Period is locked' using errcode = 'P0001', hint = 'period_locked';
  end if;
  current_context := private.document_review_context(doc.id);
  if current_context is distinct from expected_context then
    raise exception 'review inputs changed during preparation' using errcode = 'P0001', hint = 'review_context_changed';
  end if;
  if exists (select 1 from jsonb_array_elements(findings) f where f ->> 'severity' = 'error') then
    raise exception 'Document validation errors must be resolved' using errcode = 'P0001', hint = case
      when coalesce(payload ->> 'direction', '') not in ('incoming', 'outgoing') then 'direction_required'
      when nullif(payload ->> 'proposedVatRegime', '') is null then 'vat_regime_required'
      when private.missing_required_reporting_vat_id(payload) then 'counterparty_vat_id_required'
      else 'document_validation_failed' end;
  end if;
  select coalesce(jsonb_agg(f order by f::text), '[]'::jsonb) into warning_findings from jsonb_array_elements(findings) f where f ->> 'severity' = 'warning';
  if warning_findings <> '[]'::jsonb
    and not exists (select 1 from public.document_review_confirmation c where c.id = acknowledgement and c.document_id = doc.id
      and c.actor_user_id = auth.uid() and c.payload = save_and_approve_document.payload and c.findings = save_and_approve_document.findings and c.context = current_context) then
    insert into public.document_review_confirmation(document_id, organization_id, company_id, actor_user_id, payload, findings, context)
      values(doc.id, doc.organization_id, doc.company_id, auth.uid(), payload, findings, current_context) returning id into confirmation_id;
    -- The application may acknowledge an unchanged visible warning list only
    -- after reading the actual current Bank Account Check projection. The same
    -- expected_context is checked again if it immediately confirms this receipt.
    return jsonb_build_object('confirmationId', confirmation_id, 'findings', findings,
      'unchanged', (private.document_review_data(current_payload) - 'counterpartyLink') = (private.document_review_data(payload) - 'counterpartyLink')
        and (current_payload #>> '{counterpartyLink,id}') is not distinct from (payload #>> '{counterpartyLink,id}'));
  end if;
  -- Confidence is AI metadata; schemaVersion describes draft compatibility.
  if private.document_review_data(current_payload) = private.document_review_data(payload) then
    approved_version := current_version;
  else
    approved_version := public.correct_document(target_document_id, based_on_version, payload, findings);
  end if;
  -- Existing triggers enforce accounting invariants even when callers forge findings.
  perform public.approve_document(target_document_id, approved_version);
  insert into public.document_approval_receipt(document_id, request_id, organization_id, company_id, actor_user_id, submitted_payload, based_on_version, operation_kind, version)
    values (doc.id, request_id, doc.organization_id, doc.company_id, auth.uid(), submitted_payload, based_on_version, 'approval', approved_version);
  return jsonb_build_object('version', approved_version);
end;
$$;
revoke all on function public.save_and_approve_document(uuid, integer, uuid, jsonb, jsonb, jsonb, jsonb, uuid) from public, anon, service_role;
grant execute on function public.save_and_approve_document(uuid, integer, uuid, jsonb, jsonb, jsonb, jsonb, uuid) to authenticated;
