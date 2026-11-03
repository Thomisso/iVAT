-- ADR-0018: explicit observations never update accounting or Extraction history.
create table public.bank_account_check (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organization(id),
  company_id uuid not null references public.company(id),
  document_id uuid not null references public.document(id) on delete cascade,
  extraction_version_id uuid not null references public.extraction_version(id) on delete cascade,
  checked_at timestamptz not null default clock_timestamp(),
  -- Actor ids remain after User erasure, as in the append-only Audit Trail.
  checked_by uuid,
  outcome text not null check (outcome in ('published', 'unpublished', 'unavailable', 'unverified', 'missing', 'inconsistent', 'unrecognized'))
);
create index bank_account_check_document_history on public.bank_account_check(document_id, checked_at desc, id);
alter table public.bank_account_check enable row level security;
revoke all on public.bank_account_check from anon, authenticated, service_role;
grant select on public.bank_account_check to authenticated, service_role;
create policy bank_account_check_read on public.bank_account_check for select to authenticated
  using (private.can_access_company(company_id, organization_id));

create function public.record_bank_account_check(target_document_id uuid, checked_version_id uuid, check_outcome text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare doc public.document; observation_id uuid;
begin
  select * into doc from public.document where id = target_document_id;
  if not found or not private.can_access_company(doc.company_id, doc.organization_id) then raise insufficient_privilege; end if;
  -- Match accounting transition lock order, without changing either row.
  -- Keep deletion/correction races from invalidating the input receipt mid-write.
  perform 1 from public.company where id = doc.company_id for key share;
  select * into doc from public.document where id = target_document_id for key share;
  if not found or not private.can_access_company(doc.company_id, doc.organization_id) then raise insufficient_privilege; end if;
  -- An older Version is intentional: a delayed response remains history, never a
  -- verification of corrected data. The immutable Version is the input receipt.
  if doc.superseded_at is not null or not exists (
    select 1 from public.extraction_version where id = checked_version_id and document_id = doc.id
      and company_id = doc.company_id and organization_id = doc.organization_id
  ) then raise insufficient_privilege; end if;
  if check_outcome is null or check_outcome not in ('published', 'unpublished', 'unavailable', 'unverified', 'missing', 'inconsistent', 'unrecognized') then
    raise exception 'invalid Bank Account Check outcome' using errcode = 'P0001', hint = 'invalid_choice';
  end if;
  insert into public.bank_account_check(organization_id, company_id, document_id, extraction_version_id, checked_by, outcome)
    values (doc.organization_id, doc.company_id, doc.id, checked_version_id, auth.uid(), check_outcome) returning id into observation_id;
  perform private.record_audit_event('bank_account_check.recorded', doc.organization_id, doc.company_id, 'document', doc.id,
    jsonb_build_object('bank_account_check_id', observation_id, 'extraction_version_id', checked_version_id, 'outcome', check_outcome));
  return observation_id;
end;
$$;
revoke all on function public.record_bank_account_check(uuid, uuid, text) from public, anon, authenticated, service_role;
grant execute on function public.record_bank_account_check(uuid, uuid, text) to authenticated;

-- Previous observations remain immutable even for privileged clients.
create function private.prevent_bank_account_check_change()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  -- Match Extraction Version retention: the existing authorized Upload Batch
  -- deletion first removes the Document under its Period Lock guard.
  if tg_op = 'DELETE' and not exists (select 1 from public.document where id = old.document_id) then return old; end if;
  raise exception 'bank_account_check is append-only' using errcode = '42501';
end;
$$;
revoke all on function private.prevent_bank_account_check_change() from public;
create trigger bank_account_check_append_only before update or delete on public.bank_account_check
  for each row execute function private.prevent_bank_account_check_change();
create trigger bank_account_check_no_truncate before truncate on public.bank_account_check
  for each statement execute function private.prevent_bank_account_check_change();
