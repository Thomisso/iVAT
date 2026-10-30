-- Request capabilities are delivered only inside native recovery emails. A
-- generic OTP/magic-link session alone never authorizes password recovery.
create table private.password_recovery_request (
  token_hash text primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  expires_at timestamptz not null default now() + interval '1 hour',
  verified_at timestamptz
);
alter table private.password_recovery_request enable row level security;
revoke all on private.password_recovery_request from public, anon, authenticated, service_role;

create function public.create_password_recovery_request(target_email text)
returns text language plpgsql security definer set search_path = '' as $$
declare token text := encode(extensions.gen_random_bytes(32), 'hex'); target_user_id uuid;
begin
  select id into target_user_id from auth.users where lower(email) = lower(trim(target_email));
  if target_user_id is not null then
    insert into private.password_recovery_request(token_hash, user_id)
      values (encode(extensions.digest(token, 'sha256'), 'hex'), target_user_id);
  end if;
  -- Unknown addresses get a discarded random capability, with identical shape.
  return token;
end;
$$;
revoke execute on function public.create_password_recovery_request(text) from public, anon, authenticated, service_role;
grant execute on function public.create_password_recovery_request(text) to service_role;

create table private.password_recovery_intent (
  session_id uuid primary key references auth.sessions(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  expires_at timestamptz not null,
  state text not null default 'ready' check (state in ('ready', 'updating', 'used')),
  attempt_id uuid
);
alter table private.password_recovery_intent enable row level security;
revoke all on private.password_recovery_intent from public, anon, authenticated, service_role;

create function public.password_recovery_link_status(request_token text)
returns text language sql stable security definer set search_path = '' as $$
  select coalesce((select case
    when verified_at is not null then 'used'
    when expires_at <= now() then 'expired'
    else 'valid' end
    from private.password_recovery_request
    where token_hash = encode(extensions.digest(request_token, 'sha256'), 'hex')), 'invalid');
$$;
revoke execute on function public.password_recovery_link_status(text) from public, anon, authenticated, service_role;
grant execute on function public.password_recovery_link_status(text) to anon, authenticated;

-- Only the narrow server verifier calls this, after actual verifyOtp(recovery).
-- Request possession proves the recovery email; AMR 'otp' alone cannot do so.
create function public.authorize_password_recovery(request_token text, verified_session_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare request private.password_recovery_request; native_user_id uuid;
begin
  select * into request from private.password_recovery_request
    where token_hash = encode(extensions.digest(request_token, 'sha256'), 'hex') for update;
  if request.token_hash is null then
    raise exception 'invalid recovery' using errcode = 'P0001', hint = 'recovery_link_invalid';
  end if;
  if request.verified_at is not null then
    raise exception 'used recovery' using errcode = 'P0001', hint = 'recovery_link_used';
  end if;
  if request.expires_at <= now() then
    raise exception 'expired recovery' using errcode = 'P0001', hint = 'recovery_link_expired';
  end if;
  select user_id into native_user_id from auth.sessions
    where id = verified_session_id and created_at >= now() - interval '1 minute';
  if native_user_id is distinct from request.user_id then raise insufficient_privilege; end if;
  insert into private.password_recovery_intent(session_id, user_id, expires_at)
    values (verified_session_id, request.user_id, request.expires_at);
  update private.password_recovery_request set verified_at = clock_timestamp() where token_hash = request.token_hash;
end;
$$;
revoke execute on function public.authorize_password_recovery(text, uuid) from public, anon, authenticated, service_role;
grant execute on function public.authorize_password_recovery(text, uuid) to service_role;

create or replace function public.password_recovery_status()
returns text language sql stable security definer set search_path = '' as $$
  select coalesce((select case
    when state = 'used' then 'complete'
    when state <> 'ready' then 'used'
    when expires_at <= now() then 'expired'
    else 'ready' end
    from private.password_recovery_intent
    where user_id = auth.uid() and session_id::text = auth.jwt() ->> 'session_id'), 'invalid');
$$;
revoke execute on function public.password_recovery_status() from public, anon, authenticated, service_role;
grant execute on function public.password_recovery_status() to authenticated;

create function public.claim_password_recovery()
returns uuid language plpgsql security definer set search_path = '' as $$
declare intent private.password_recovery_intent; attempt uuid := gen_random_uuid();
begin
  select * into intent from private.password_recovery_intent
    where user_id = auth.uid() and session_id::text = auth.jwt() ->> 'session_id' for update;
  if intent.session_id is null then
    raise exception 'invalid recovery' using errcode = 'P0001', hint = 'recovery_link_invalid';
  end if;
  if intent.state <> 'ready' then
    raise exception 'used recovery' using errcode = 'P0001', hint = 'recovery_link_used';
  end if;
  if intent.expires_at <= now() then
    raise exception 'expired recovery' using errcode = 'P0001', hint = 'recovery_link_expired';
  end if;
  -- Use actual native AAL2, never the application's legacy backup-code flag.
  if private.current_user_has_totp() and coalesce(auth.jwt() ->> 'aal', '') <> 'aal2' then
    raise exception 'authenticator required' using errcode = 'P0001', hint = 'mfa_verification_required';
  end if;
  update private.password_recovery_intent set state = 'updating', attempt_id = attempt where session_id = intent.session_id;
  return attempt;
end;
$$;
revoke execute on function public.claim_password_recovery() from public, anon, authenticated, service_role;
grant execute on function public.claim_password_recovery() to authenticated;

create function public.finish_password_recovery(recovery_attempt_id uuid, succeeded boolean)
returns void language plpgsql security definer set search_path = '' as $$
begin
  update private.password_recovery_intent
    set state = case when succeeded then 'used' else 'ready' end, attempt_id = null
    where user_id = auth.uid() and session_id::text = auth.jwt() ->> 'session_id'
      and state = 'updating' and attempt_id = recovery_attempt_id;
  if not found then raise insufficient_privilege; end if;
end;
$$;
revoke execute on function public.finish_password_recovery(uuid, boolean) from public, anon, authenticated, service_role;
grant execute on function public.finish_password_recovery(uuid, boolean) to authenticated;
