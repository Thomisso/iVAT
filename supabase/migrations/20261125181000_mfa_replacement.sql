-- Legacy prepared codes remain hashed and single-use. Recovery is a restriction,
-- never an application substitute for native Auth AAL2.
create table private.mfa_replacement (
  user_id uuid primary key references auth.users(id) on delete cascade,
  session_id uuid not null,
  continuation_hash bytea not null,
  replacement_factor_id uuid,
  started_at timestamptz not null default clock_timestamp(),
  completed_at timestamptz,
  access_after timestamptz,
  operation_id uuid,
  operation_kind text check (operation_kind in ('enroll', 'finish')),
  operation_expires_at timestamptz,
  operation_started_at timestamptz,
  operation_factor_ids uuid[] not null default '{}',
  password_updated_at timestamptz,
  native_finish_confirmed_at timestamptz
);
alter table private.mfa_replacement enable row level security;
revoke all on private.mfa_replacement from public, anon, authenticated, service_role;
alter table private.mfa_recovery_code enable row level security;
alter table private.mfa_recovery_session enable row level security;
revoke all on private.mfa_recovery_code, private.mfa_recovery_session from public, anon, authenticated, service_role;

create function private.recovery_data_access_allowed()
returns boolean language sql stable security definer set search_path = '' as $$
  select not exists(select 1 from private.mfa_replacement where user_id = auth.uid())
    or exists (
      select 1 from private.mfa_replacement r join auth.sessions s on s.user_id = r.user_id
      where r.user_id = auth.uid() and r.completed_at is not null
        and s.id::text = auth.jwt() ->> 'session_id'
        and (s.id = r.session_id or s.created_at >= r.access_after)
        and (r.replacement_factor_id is null or (
          s.factor_id = r.replacement_factor_id and s.aal::text = 'aal2'
          and exists(select 1 from auth.mfa_factors f where f.id = r.replacement_factor_id
            and f.user_id = r.user_id and f.status::text = 'verified')
        ))
    );
$$;
revoke execute on function private.recovery_data_access_allowed() from public, anon, authenticated, service_role;

create or replace function private.current_user_mfa_satisfied()
returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce(auth.jwt() ->> 'aal', '') = 'aal2' and private.recovery_data_access_allowed()
    and (not exists(select 1 from private.mfa_replacement where user_id = auth.uid())
      or exists(select 1 from auth.sessions where user_id = auth.uid()
        and id::text = auth.jwt() ->> 'session_id' and aal::text = 'aal2'));
$$;

create or replace function private.organization_mfa_satisfied(target_organization_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select private.recovery_data_access_allowed() and coalesce((
    select not (o.mfa_required or private.is_super_admin(auth.uid()) or private.current_user_has_totp())
      or private.current_user_mfa_satisfied()
    from public.organization o where o.id = target_organization_id and o.blocked_at is null
  ), false);
$$;

-- The old path must not consume a prepared code or grant ordinary data access.
create or replace function public.verify_mfa_recovery_code(input_code text)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  raise exception 'verified email recovery required' using errcode = 'P0001', hint = 'email_recovery_required';
end;
$$;
revoke execute on function public.verify_mfa_recovery_code(text) from public, anon, authenticated, service_role;
grant execute on function public.verify_mfa_recovery_code(text) to authenticated;

create function public.begin_mfa_replacement(input_code text, continuation_token text default '')
returns text language plpgsql security definer set search_path = '' as $$
declare target_user uuid := auth.uid(); target_session uuid; pending private.mfa_replacement;
  continuation text := encode(extensions.gen_random_bytes(32), 'hex'); consumed uuid;
  normalized text := lower(regexp_replace(input_code, '[^a-zA-Z0-9]', '', 'g'));
begin
  select i.session_id into target_session from private.password_recovery_intent i join auth.sessions s on s.id = i.session_id
    where i.user_id = target_user and i.session_id::text = auth.jwt() ->> 'session_id'
      and i.state = 'ready' and i.expires_at > now() and s.user_id = target_user;
  if target_session is null then
    raise exception 'verified email recovery required' using errcode = 'P0001', hint = 'email_recovery_required';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(target_user::text, 168));
  select * into pending from private.mfa_replacement where user_id = target_user for update;
  if pending.user_id is not null and pending.completed_at is null and nullif(continuation_token, '') is not null
    and pending.continuation_hash = extensions.digest(continuation_token, 'sha256') then
    null;
  else
    update private.mfa_recovery_code set used_at = clock_timestamp()
      where id = (select id from private.mfa_recovery_code where user_id = target_user and used_at is null
        and code_hash = extensions.digest(normalized, 'sha256') for update skip locked limit 1)
      returning id into consumed;
    if consumed is null then
      raise exception 'invalid recovery code' using errcode = 'P0001', hint = 'invalid_mfa_code';
    end if;
  end if;
  insert into private.mfa_replacement(user_id, session_id, continuation_hash)
    values(target_user, target_session, extensions.digest(continuation, 'sha256'))
    on conflict(user_id) do update set session_id = excluded.session_id, continuation_hash = excluded.continuation_hash,
      replacement_factor_id = case when mfa_replacement.completed_at is null then mfa_replacement.replacement_factor_id else null end,
      password_updated_at = case when mfa_replacement.completed_at is null then mfa_replacement.password_updated_at else null end,
      native_finish_confirmed_at = null,
      completed_at = null, started_at = clock_timestamp(), operation_id = null, operation_kind = null, operation_expires_at = null;
  perform private.record_user_mfa_change('user.mfa_recovery_started');
  return continuation;
end;
$$;
revoke execute on function public.begin_mfa_replacement(text, text) from public, anon, authenticated, service_role;
grant execute on function public.begin_mfa_replacement(text, text) to authenticated;

create function public.mfa_replacement_status()
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce((select jsonb_build_object(
    'pending', r.completed_at is null,
    'authorized', r.completed_at is null and r.session_id::text = auth.jwt() ->> 'session_id'
      and exists(select 1 from auth.sessions s where s.id = r.session_id and s.user_id = auth.uid())
      and exists(select 1 from private.password_recovery_intent i where i.session_id = r.session_id
        and i.user_id = auth.uid() and (i.state = 'ready' or r.password_updated_at is not null)
        and (i.expires_at > now() or r.native_finish_confirmed_at is not null)),
    'factorId', case when r.completed_at is not null or r.session_id::text = auth.jwt() ->> 'session_id' then r.replacement_factor_id else null end,
    'factorVerified', exists(select 1 from auth.mfa_factors f where f.id = r.replacement_factor_id and f.status::text = 'verified'),
    'passwordUpdated', r.password_updated_at is not null,
    'completionReady', r.native_finish_confirmed_at is not null,
    'hasHistory', true,
    'accessAllowed', private.recovery_data_access_allowed(),
    'needsRecovery', r.completed_at is not null and r.replacement_factor_id is not null
      and not exists(select 1 from auth.mfa_factors f where f.id = r.replacement_factor_id and f.status::text = 'verified')
  ) from private.mfa_replacement r where r.user_id = auth.uid()),
  '{"pending":false,"authorized":false,"factorId":null,"factorVerified":false,"passwordUpdated":false,"completionReady":false,"hasHistory":false,"accessAllowed":true,"needsRecovery":false}'::jsonb);
$$;
revoke execute on function public.mfa_replacement_status() from public, anon, authenticated, service_role;
grant execute on function public.mfa_replacement_status() to authenticated;

-- MFA recovery events contain only ids and no code, secret, password or email.
create or replace function private.record_user_mfa_change(event_action text)
returns void language plpgsql security definer set search_path = '' as $$
declare target_user_id uuid := auth.uid(); target_organization_id uuid;
begin
  if target_user_id is null then raise insufficient_privilege; end if;
  if event_action not in ('user.mfa_enrolled', 'user.mfa_disenrolled', 'user.mfa_recovery_started', 'user.mfa_recovered') then
    raise exception 'invalid_action' using errcode = '22023';
  end if;
  for target_organization_id in select distinct organization_id from public.membership where user_id = target_user_id loop
    perform private.record_audit_event(event_action, target_organization_id, null, 'user', target_user_id, '{}'::jsonb);
  end loop;
end;
$$;

create function private.require_mfa_replacement()
returns private.mfa_replacement language plpgsql security definer set search_path = '' as $$
declare pending private.mfa_replacement;
begin
  select * into pending from private.mfa_replacement where user_id = auth.uid() for update;
  if pending.user_id is null or pending.completed_at is not null then
    raise exception 'replacement required' using errcode = 'P0001', hint = 'mfa_recovery_required';
  end if;
  if pending.session_id::text <> coalesce(auth.jwt() ->> 'session_id', '')
    or not exists(select 1 from auth.sessions s where s.id = pending.session_id and s.user_id = auth.uid())
    or not exists(select 1 from private.password_recovery_intent i where i.session_id = pending.session_id
      and i.user_id = auth.uid() and (i.state = 'ready' or pending.password_updated_at is not null)
      and (i.expires_at > now() or pending.native_finish_confirmed_at is not null)) then
    raise exception 'verified recovery session required' using errcode = 'P0001', hint = 'email_recovery_required';
  end if;
  return pending;
end;
$$;
revoke execute on function private.require_mfa_replacement() from public, anon, authenticated, service_role;

create function public.claim_mfa_replacement_operation(operation text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare pending private.mfa_replacement; claim uuid := gen_random_uuid();
begin
  pending := private.require_mfa_replacement();
  if operation not in ('enroll', 'finish') then raise insufficient_privilege; end if;
  if pending.operation_id is not null and pending.operation_expires_at > now() then
    raise exception 'recovery busy' using errcode = 'P0001', hint = 'mfa_recovery_busy';
  end if;
  if operation = 'finish' and not exists (
    select 1 from auth.sessions s join auth.mfa_factors f on f.id = s.factor_id
    where s.id = pending.session_id and s.user_id = pending.user_id and s.aal::text = 'aal2'
      and f.id = pending.replacement_factor_id and f.user_id = pending.user_id and f.status::text = 'verified'
  ) then raise exception 'native verification required' using errcode = 'P0001', hint = 'mfa_verification_required'; end if;
  update private.mfa_replacement set operation_id = claim, operation_kind = operation,
    operation_started_at = clock_timestamp(), operation_expires_at = now() + interval '1 minute',
    operation_factor_ids = coalesce((select array_agg(id) from auth.mfa_factors where user_id = pending.user_id), '{}'),
    replacement_factor_id = case when operation = 'enroll' then null else replacement_factor_id end,
    native_finish_confirmed_at = null
    where user_id = pending.user_id;
  return claim;
end;
$$;
revoke execute on function public.claim_mfa_replacement_operation(text) from public, anon, authenticated, service_role;
grant execute on function public.claim_mfa_replacement_operation(text) to authenticated;

create function public.release_mfa_replacement_operation(recovery_operation_id uuid)
returns void language sql security definer set search_path = '' as $$
  update private.mfa_replacement set operation_id = null, operation_kind = null, operation_expires_at = null
    where user_id = auth.uid() and session_id::text = auth.jwt() ->> 'session_id'
      and operation_id = recovery_operation_id and completed_at is null;
$$;
revoke execute on function public.release_mfa_replacement_operation(uuid) from public, anon, authenticated, service_role;
grant execute on function public.release_mfa_replacement_operation(uuid) to authenticated;

create function public.mfa_replacement_authority(recovery_operation_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare pending private.mfa_replacement; factors uuid[];
begin
  select * into pending from private.mfa_replacement where operation_id = recovery_operation_id;
  if pending.user_id is null or pending.completed_at is not null or pending.operation_expires_at <= now()
    or not exists(select 1 from auth.sessions s where s.id = pending.session_id and s.user_id = pending.user_id)
    or not exists(select 1 from private.password_recovery_intent i where i.session_id = pending.session_id
      and i.user_id = pending.user_id and (i.state = 'ready' or pending.password_updated_at is not null)
      and i.expires_at > now()) then raise insufficient_privilege; end if;
  if pending.operation_kind = 'enroll' then
    select coalesce(array_agg(id), '{}') into factors from auth.mfa_factors
      where user_id = pending.user_id and id = any(pending.operation_factor_ids);
  else
    if not exists(select 1 from auth.sessions s join auth.mfa_factors f on f.id = s.factor_id
      where s.id = pending.session_id and s.user_id = pending.user_id and s.aal::text = 'aal2'
        and f.id = pending.replacement_factor_id and f.user_id = pending.user_id and f.status::text = 'verified') then
      raise insufficient_privilege;
    end if;
    select coalesce(array_agg(id), '{}') into factors from auth.mfa_factors
      where user_id = pending.user_id and id <> pending.replacement_factor_id;
  end if;
  return jsonb_build_object('userId', pending.user_id, 'sessionId', pending.session_id, 'factorId', pending.replacement_factor_id,
    'kind', pending.operation_kind, 'removeFactorIds', factors, 'passwordUpdated', pending.password_updated_at is not null);
end;
$$;
revoke execute on function public.mfa_replacement_authority(uuid) from public, anon, authenticated, service_role;
grant execute on function public.mfa_replacement_authority(uuid) to service_role;

create function public.bind_mfa_replacement_factor(recovery_operation_id uuid, enrolled_factor_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare pending private.mfa_replacement;
begin
  perform public.mfa_replacement_authority(recovery_operation_id);
  select * into pending from private.mfa_replacement where operation_id = recovery_operation_id for update;
  if pending.operation_kind <> 'enroll' or not exists(select 1 from auth.mfa_factors f
    where f.id = enrolled_factor_id and f.user_id = pending.user_id and f.status::text = 'unverified'
      and f.created_at >= pending.operation_started_at and not (f.id = any(pending.operation_factor_ids))) then
    raise insufficient_privilege;
  end if;
  update private.mfa_replacement set replacement_factor_id = enrolled_factor_id where user_id = pending.user_id;
end;
$$;
revoke execute on function public.bind_mfa_replacement_factor(uuid, uuid) from public, anon, authenticated, service_role;
grant execute on function public.bind_mfa_replacement_factor(uuid, uuid) to service_role;

create function public.confirm_mfa_replacement_password(recovery_operation_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare pending private.mfa_replacement;
begin
  perform public.mfa_replacement_authority(recovery_operation_id);
  select * into pending from private.mfa_replacement where operation_id = recovery_operation_id for update;
  if pending.operation_kind <> 'finish' then raise insufficient_privilege; end if;
  update private.mfa_replacement set password_updated_at = clock_timestamp() where user_id = pending.user_id;
  update private.password_recovery_intent set state = 'used', attempt_id = null where session_id = pending.session_id and user_id = pending.user_id;
end;
$$;
revoke execute on function public.confirm_mfa_replacement_password(uuid) from public, anon, authenticated, service_role;
grant execute on function public.confirm_mfa_replacement_password(uuid) to service_role;

create function public.confirm_mfa_replacement_native_finish(recovery_operation_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare pending private.mfa_replacement;
begin
  perform public.mfa_replacement_authority(recovery_operation_id);
  select * into pending from private.mfa_replacement where operation_id = recovery_operation_id for update;
  if pending.operation_kind <> 'finish' or pending.password_updated_at is null
    or exists(select 1 from auth.mfa_factors where user_id = pending.user_id and id <> pending.replacement_factor_id) then
    raise insufficient_privilege;
  end if;
  update private.mfa_replacement set native_finish_confirmed_at = clock_timestamp() where user_id = pending.user_id;
end;
$$;
revoke execute on function public.confirm_mfa_replacement_native_finish(uuid) from public, anon, authenticated, service_role;
grant execute on function public.confirm_mfa_replacement_native_finish(uuid) to service_role;

create function public.complete_mfa_replacement()
returns void language plpgsql security definer set search_path = '' as $$
declare pending private.mfa_replacement;
begin
  pending := private.require_mfa_replacement();
  if pending.native_finish_confirmed_at is null or pending.password_updated_at is null
    or not exists(select 1 from auth.sessions s join auth.mfa_factors f on f.id = s.factor_id
      where s.id = pending.session_id and s.user_id = pending.user_id and s.aal::text = 'aal2'
        and f.id = pending.replacement_factor_id and f.user_id = pending.user_id and f.status::text = 'verified')
    or exists(select 1 from auth.mfa_factors where user_id = pending.user_id and id <> pending.replacement_factor_id) then
    raise insufficient_privilege;
  end if;
  update private.mfa_replacement set completed_at = clock_timestamp(), access_after = clock_timestamp(),
    operation_id = null, operation_kind = null, operation_expires_at = null where user_id = pending.user_id;
  perform private.record_user_mfa_change('user.mfa_recovered');
end;
$$;
revoke execute on function public.complete_mfa_replacement() from public, anon, authenticated, service_role;
grant execute on function public.complete_mfa_replacement() to authenticated;

create or replace function public.current_mfa_policy()
returns table(required boolean, enrolled boolean, satisfied boolean)
language sql stable security definer set search_path = '' as $$
  with policy as (
    select private.is_super_admin(auth.uid()) or exists(select 1 from public.membership m
      join public.organization o on o.id = m.organization_id where m.user_id = auth.uid() and o.mfa_required)
      or exists(select 1 from private.mfa_replacement where user_id = auth.uid() and completed_at is null) as required,
      private.current_user_has_totp() as enrolled
  ) select policy.required, policy.enrolled,
    private.recovery_data_access_allowed() and (not (policy.required or policy.enrolled) or private.current_user_mfa_satisfied()) from policy;
$$;

-- Ordinary reset cannot bypass the factor-restoration/fail-closed cleanup path.
create or replace function public.claim_password_recovery()
returns uuid language plpgsql security definer set search_path = '' as $$
declare intent private.password_recovery_intent; attempt uuid := gen_random_uuid();
begin
  if exists(select 1 from private.mfa_replacement where user_id = auth.uid() and completed_at is null) then
    raise exception 'factor restoration required' using errcode = 'P0001', hint = 'mfa_recovery_required';
  end if;
  if exists(select 1 from private.mfa_replacement where user_id = auth.uid() and replacement_factor_id is not null)
    and not private.recovery_data_access_allowed() then
    raise exception 'trusted authenticator required' using errcode = 'P0001', hint = 'mfa_verification_required';
  end if;
  select * into intent from private.password_recovery_intent
    where user_id = auth.uid() and session_id::text = auth.jwt() ->> 'session_id' for update;
  if intent.session_id is null then raise exception 'invalid recovery' using errcode = 'P0001', hint = 'recovery_link_invalid'; end if;
  if intent.state <> 'ready' then raise exception 'used recovery' using errcode = 'P0001', hint = 'recovery_link_used'; end if;
  if intent.expires_at <= now() then raise exception 'expired recovery' using errcode = 'P0001', hint = 'recovery_link_expired'; end if;
  if private.current_user_has_totp() and coalesce(auth.jwt() ->> 'aal', '') <> 'aal2' then
    raise exception 'authenticator required' using errcode = 'P0001', hint = 'mfa_verification_required';
  end if;
  update private.password_recovery_intent set state = 'updating', attempt_id = attempt where session_id = intent.session_id;
  return attempt;
end;
$$;
revoke execute on function private.record_user_mfa_change(text) from public, anon, authenticated, service_role;

-- Affected Users can still maintain factors normally, but a native factor born
-- in the removal window cannot nominate itself as the trusted replacement.
create table private.mfa_maintenance (
  session_id uuid primary key references auth.sessions(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  operation text not null check(operation in ('enroll', 'remove')),
  expires_at timestamptz not null default now() + interval '5 minutes'
);
alter table private.mfa_maintenance enable row level security;
revoke all on private.mfa_maintenance from public, anon, authenticated, service_role;

create function public.authorize_mfa_maintenance(operation text)
returns void language plpgsql security definer set search_path = '' as $$
declare history private.mfa_replacement; native_session auth.sessions;
begin
  select * into history from private.mfa_replacement where user_id = auth.uid();
  if history.user_id is null then return; end if;
  if history.completed_at is null or not private.recovery_data_access_allowed() or operation not in ('enroll', 'remove') then
    raise exception 'recovery required' using errcode = 'P0001', hint = 'mfa_recovery_required';
  end if;
  select * into native_session from auth.sessions where user_id = auth.uid() and id::text = auth.jwt() ->> 'session_id';
  if native_session.id is null or (private.current_user_has_totp() and native_session.aal::text <> 'aal2') then
    raise insufficient_privilege;
  end if;
  insert into private.mfa_maintenance(session_id, user_id, operation)
    values(native_session.id, auth.uid(), operation)
    on conflict(session_id) do update set operation = excluded.operation, expires_at = now() + interval '5 minutes';
end;
$$;
revoke execute on function public.authorize_mfa_maintenance(text) from public, anon, authenticated, service_role;
grant execute on function public.authorize_mfa_maintenance(text) to authenticated;

create or replace function public.finish_mfa_enrollment()
returns text[] language plpgsql security definer set search_path = '' as $$
declare target_user uuid := auth.uid(); history private.mfa_replacement; selected_factor uuid;
  codes text[] := '{}'; code text; i integer;
begin
  if target_user is null or coalesce(auth.jwt() ->> 'aal', '') <> 'aal2' then raise insufficient_privilege; end if;
  select * into history from private.mfa_replacement where user_id = target_user for update;
  if history.user_id is not null then
    if history.completed_at is null or not exists(select 1 from private.mfa_maintenance where user_id = target_user
      and session_id::text = auth.jwt() ->> 'session_id' and operation = 'enroll' and expires_at > now()) then
      raise insufficient_privilege;
    end if;
    select s.factor_id into selected_factor from auth.sessions s join auth.mfa_factors f on f.id = s.factor_id
      where s.id::text = auth.jwt() ->> 'session_id' and s.user_id = target_user and s.aal::text = 'aal2'
        and f.user_id = target_user and f.status::text = 'verified' and f.factor_type::text = 'totp';
    if selected_factor is null then raise insufficient_privilege; end if;
    update private.mfa_replacement set replacement_factor_id = selected_factor where user_id = target_user;
    delete from private.mfa_maintenance where user_id = target_user and session_id::text = auth.jwt() ->> 'session_id';
  end if;
  delete from private.mfa_recovery_code where user_id = target_user;
  for i in 1..10 loop
    code := encode(extensions.gen_random_bytes(8), 'hex');
    insert into private.mfa_recovery_code(user_id, code_hash) values(target_user, extensions.digest(code, 'sha256'));
    codes := array_append(codes, code);
  end loop;
  perform private.record_user_mfa_change('user.mfa_enrolled');
  return codes;
end;
$$;

create or replace function public.finish_mfa_disenrollment()
returns void language plpgsql security definer set search_path = '' as $$
declare target_user uuid := auth.uid(); history private.mfa_replacement;
begin
  if target_user is null or coalesce(auth.jwt() ->> 'aal', '') <> 'aal2' then raise insufficient_privilege; end if;
  select * into history from private.mfa_replacement where user_id = target_user for update;
  if history.user_id is not null then
    if history.completed_at is null or not exists(select 1 from private.mfa_maintenance where user_id = target_user
      and session_id::text = auth.jwt() ->> 'session_id' and operation = 'remove' and expires_at > now()) then
      raise insufficient_privilege;
    end if;
    if not exists(select 1 from auth.mfa_factors where id = history.replacement_factor_id and user_id = target_user and status::text = 'verified') then
      if exists(select 1 from auth.mfa_factors where user_id = target_user and status::text = 'verified') then raise insufficient_privilege; end if;
      update private.mfa_replacement set replacement_factor_id = null where user_id = target_user;
    end if;
    delete from private.mfa_maintenance where user_id = target_user and session_id::text = auth.jwt() ->> 'session_id';
  end if;
  delete from private.mfa_recovery_code where user_id = target_user;
  delete from private.mfa_recovery_session where user_id = target_user;
  perform private.record_user_mfa_change('user.mfa_disenrolled');
end;
$$;


-- A restricted recovery session cannot accept additional business access.
create or replace function private.accept_invitation_target(target_invitation_id uuid, acceptance_claim_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare target public.invitation; claim private.invitation_acceptance_claim; member_id uuid;
begin
  if not private.recovery_data_access_allowed() then raise insufficient_privilege; end if;
  select * into target from public.invitation where id = target_invitation_id for update;
  perform private.require_valid_invitation(target);
  if auth.uid() is null or lower(coalesce(auth.jwt() ->> 'email', '')) <> target.email then
    raise insufficient_privilege;
  end if;
  if acceptance_claim_id is not null then
    select * into claim from private.invitation_acceptance_claim where id = acceptance_claim_id for update;
    if claim.id is null or claim.invitation_id <> target.id or claim.state <> 'active' or claim.expires_at <= now()
      or auth.uid() is distinct from coalesce(claim.expected_user_id, claim.provisioned_user_id) then
      raise insufficient_privilege;
    end if;
  elsif exists (
    select 1 from auth.users u join private.invitation_acceptance_claim c
      on c.id::text = u.raw_app_meta_data ->> 'ivat_invitation_claim'
    where u.id = auth.uid() and c.state <> 'accepted'
  ) then raise insufficient_privilege;
  end if;
  insert into public.membership(user_id, organization_id, company_id, role, email)
  values(auth.uid(), target.organization_id, target.company_id, target.role, target.email)
  on conflict (user_id, organization_id, company_id) do update set role = excluded.role, email = excluded.email
    returning id into member_id;
  update public.invitation set accepted_at = clock_timestamp(), accepted_by = auth.uid() where id = target.id;
  if acceptance_claim_id is not null then
    update private.invitation_acceptance_claim set state = 'accepted' where id = acceptance_claim_id;
  end if;
  perform private.record_audit_event('membership.created', target.organization_id, target.company_id,
    'membership', member_id, jsonb_build_object('role', target.role, 'user_id', auth.uid()));
end;
$$;
