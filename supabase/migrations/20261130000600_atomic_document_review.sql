create table public.document_approval_receipt (
  document_id uuid not null references public.document(id) on delete cascade,
  request_id uuid not null,
  organization_id uuid not null references public.organization(id),
  company_id uuid not null references public.company(id),
  actor_user_id uuid not null,
  submitted_payload jsonb not null,
  based_on_version integer not null,
  version integer not null,
  created_at timestamptz not null default now(),
  primary key (document_id, request_id)
);
alter table public.document_approval_receipt enable row level security;
revoke all on public.document_approval_receipt from anon, authenticated, service_role;
grant select on public.document_approval_receipt to authenticated;
create policy document_approval_receipt_read on public.document_approval_receipt for select to authenticated
  using (actor_user_id = auth.uid() and private.can_access_company(company_id, organization_id));

-- A receipt is a result, never permission to mutate an already approved Document.
create or replace function public.document_approval_result(target_document_id uuid, request_id uuid, submitted_payload jsonb, based_on_version integer)
returns integer language plpgsql security definer set search_path = '' as $$
declare doc public.document; receipt public.document_approval_receipt;
begin
  select * into doc from public.document where id = target_document_id;
  if not found or not private.can_access_company(doc.company_id, doc.organization_id) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  select * into receipt from public.document_approval_receipt r
    where r.document_id = doc.id and r.request_id = document_approval_result.request_id;
  if not found then return null; end if;
  if receipt.actor_user_id is distinct from auth.uid() or receipt.submitted_payload is distinct from submitted_payload or receipt.based_on_version is distinct from based_on_version then
    raise exception 'request identity was used for different data' using errcode = 'P0001', hint = 'stale_version';
  end if;
  return receipt.version;
end;
$$;
revoke all on function public.document_approval_result(uuid, uuid, jsonb, integer) from public, anon, service_role;
grant execute on function public.document_approval_result(uuid, uuid, jsonb, integer) to authenticated;

-- An opaque acknowledgement records what was returned for these prepared data.
-- It is not a seal certifying external registry facts: preparation still runs in
-- the application with its registry adapter, as on the other ingestion paths.
create table public.document_review_confirmation (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references public.document(id) on delete cascade,
  organization_id uuid not null references public.organization(id),
  company_id uuid not null references public.company(id),
  actor_user_id uuid not null,
  payload jsonb not null,
  findings jsonb not null,
  context jsonb not null,
  created_at timestamptz not null default now()
);
alter table public.document_review_confirmation enable row level security;
revoke all on public.document_review_confirmation from anon, authenticated, service_role;
grant select on public.document_review_confirmation to authenticated;
create policy document_review_confirmation_read on public.document_review_confirmation for select to authenticated
  using (actor_user_id = auth.uid() and private.can_access_company(company_id, organization_id));

-- The fingerprint only detects changed database inputs; it conveys no authority.
-- Company columns deliberately include revision markers added by later features.
create or replace function private.document_review_context(target_document_id uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('fingerprint', md5(jsonb_build_object(
    'document', to_jsonb(doc), 'company', to_jsonb(company),
    'versions', (select jsonb_agg(jsonb_build_array(d.id, d.status, v.id) order by d.id)
      from public.document d left join lateral (select id from public.extraction_version where document_id = d.id order by version desc limit 1) v on true
      where d.company_id = doc.company_id),
    'periodLocks', (select jsonb_agg(to_jsonb(l) order by l.period) from public.period_lock l where l.company_id = doc.company_id),
    'reportingYears', (select jsonb_agg(to_jsonb(y) order by y.year) from public.reporting_year y where y.company_id = doc.company_id),
    'bankChecks', (select jsonb_agg(b.id order by b.id) from public.bank_account_check b where b.document_id = doc.id)
  )::text)) from public.document doc join public.company company on company.id = doc.company_id where doc.id = target_document_id;
$$;
revoke all on function private.document_review_context(uuid) from public, anon, authenticated, service_role;

create or replace function public.document_review_context(target_document_id uuid, based_on_version integer)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare doc public.document; current_version integer;
begin
  select * into doc from public.document where id = target_document_id;
  if not found or not private.can_access_company(doc.company_id, doc.organization_id) then raise insufficient_privilege; end if;
  perform 1 from public.company where id = doc.company_id for key share;
  select * into doc from public.document where id = target_document_id for key share;
  if not found or not private.can_access_company(doc.company_id, doc.organization_id) or doc.superseded_at is not null then raise insufficient_privilege; end if;
  select coalesce(max(version), 0) into current_version from public.extraction_version where document_id = doc.id;
  if current_version is distinct from based_on_version then
    raise exception 'the Document has a newer Extraction Version' using errcode = 'P0001', hint = 'stale_version';
  end if;
  if doc.status <> 'needs_review' then
    raise exception 'only a Document in review can be approved' using errcode = 'P0001', hint = 'not_in_review';
  end if;
  return private.document_review_context(doc.id);
end;
$$;
revoke all on function public.document_review_context(uuid, integer) from public, anon, service_role;
grant execute on function public.document_review_context(uuid, integer) to authenticated;

-- Only financial fields determine whether a manual correction is needed.
-- Extensions adding accounting data must add their keys here. Source metadata
-- belongs to the immutable base, not the reconstructed browser form.
create or replace function private.document_review_data(candidate jsonb)
returns jsonb language sql immutable security definer set search_path = '' as $$
  select coalesce(jsonb_object_agg(key, value), '{}'::jsonb) from jsonb_each(coalesce(candidate, '{}'::jsonb))
  where key = any(array['documentType', 'documentNumber', 'issueDate', 'taxPointDate', 'dueDate', 'direction',
    'supplier', 'customer', 'currency', 'rateBreakdown', 'totals', 'payment', 'proposedVatRegime',
    'reverseChargeCode', 'originalDocumentNumber', 'czkConversion']);
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

-- Corrections and approval share the existing Company -> Document lock order.
-- The locked base Version is also the extension point for manual evidence and
-- future accounting metadata; caller-authored source references confer no trust.
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
  current_findings jsonb;
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
  select v.version, v.payload, v.findings into current_version, current_payload, current_findings from public.extraction_version v
    where v.document_id = doc.id order by v.version desc limit 1;
  if coalesce(current_version, 0) is distinct from based_on_version then
    raise exception 'the Document has a newer Extraction Version' using errcode = 'P0001', hint = 'stale_version';
  end if;
  if doc.status <> 'needs_review' then
    raise exception 'only a Document in review can be approved' using errcode = 'P0001', hint = 'not_in_review';
  end if;
  payload := private.document_manual_review_payload(current_payload, payload);
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
    and not coalesce((private.document_review_data(current_payload) = private.document_review_data(payload)
      and warning_findings = (select coalesce(jsonb_agg(f order by f::text), '[]'::jsonb) from jsonb_array_elements(coalesce(current_findings, '[]')) f where f ->> 'severity' = 'warning')), false)
    and not exists (select 1 from public.document_review_confirmation c where c.id = acknowledgement and c.document_id = doc.id
      and c.actor_user_id = auth.uid() and c.payload = save_and_approve_document.payload and c.findings = save_and_approve_document.findings and c.context = current_context) then
    insert into public.document_review_confirmation(document_id, organization_id, company_id, actor_user_id, payload, findings, context)
      values(doc.id, doc.organization_id, doc.company_id, auth.uid(), payload, findings, current_context) returning id into confirmation_id;
    return jsonb_build_object('confirmationId', confirmation_id, 'findings', findings);
  end if;
  -- Confidence is AI metadata; schemaVersion describes draft compatibility.
  if private.document_review_data(current_payload) = private.document_review_data(payload) then
    approved_version := current_version;
  else
    approved_version := public.correct_document(target_document_id, based_on_version, payload, findings);
  end if;
  -- Existing triggers enforce accounting invariants even when callers forge findings.
  perform public.approve_document(target_document_id, approved_version);
  insert into public.document_approval_receipt(document_id, request_id, organization_id, company_id, actor_user_id, submitted_payload, based_on_version, version)
    values (doc.id, request_id, doc.organization_id, doc.company_id, auth.uid(), submitted_payload, based_on_version, approved_version);
  return jsonb_build_object('version', approved_version);
end;
$$;
revoke all on function public.save_and_approve_document(uuid, integer, uuid, jsonb, jsonb, jsonb, jsonb, uuid) from public, anon, service_role;
grant execute on function public.save_and_approve_document(uuid, integer, uuid, jsonb, jsonb, jsonb, jsonb, uuid) to authenticated;
