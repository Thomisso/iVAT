-- Append-only audit log (ADR-0005). Rows are written only by database code
-- through private.record_audit_event; the application has no insert, update
-- or delete path. No foreign keys: the log must outlive the rows it describes.

-- Never add `private` to the API's exposed schemas: its functions would become callable RPCs.
create schema private;
grant usage on schema private to authenticated;

create table public.audit_event (
  id bigint generated always as identity primary key,
  occurred_at timestamptz not null default now(),
  actor_user_id uuid,
  organization_id uuid not null,
  company_id uuid,
  action text not null,
  target_type text not null,
  target_id uuid,
  payload jsonb not null default '{}'
);

create index audit_event_organization_id_idx on public.audit_event (organization_id, id);

revoke all on public.audit_event from anon, authenticated, service_role;
grant select on public.audit_event to service_role;
grant select on public.audit_event to authenticated;

alter table public.audit_event enable row level security;
-- The read policy is defined with the tenancy model, which owns the access predicates.

-- Even privileged roles cannot rewrite history.
create function private.prevent_audit_event_change()
returns trigger
language plpgsql
as $$
begin
  raise exception 'audit_event is append-only' using errcode = '42501';
end;
$$;

create trigger audit_event_append_only
  before update or delete on public.audit_event
  for each row execute function private.prevent_audit_event_change();

create trigger audit_event_no_truncate
  before truncate on public.audit_event
  for each statement execute function private.prevent_audit_event_change();

create function private.record_audit_event(
  action text,
  organization_id uuid,
  company_id uuid,
  target_type text,
  target_id uuid,
  payload jsonb,
  actor_user_id uuid default auth.uid()
)
returns void
language sql security definer set search_path = ''
as $$
  insert into public.audit_event (actor_user_id, organization_id, company_id, action, target_type, target_id, payload)
  values (actor_user_id, organization_id, company_id, action, target_type, target_id, payload);
$$;

revoke execute on function private.record_audit_event from public;
