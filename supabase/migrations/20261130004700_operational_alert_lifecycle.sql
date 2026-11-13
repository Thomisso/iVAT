-- Delivery identity is separate from the episode's problem classification.
alter table private.operational_alert_outbox drop constraint operational_alert_outbox_kind_check;
alter table private.operational_alert_outbox drop constraint operational_alert_outbox_episode_id_user_id_kind_key;
alter table private.operational_alert_outbox add column reminder_ordinal integer not null default 0;
alter table private.operational_alert_outbox add constraint operational_alert_delivery_kind
  check ((kind in ('first', 'recovery') and reminder_ordinal = 0) or (kind = 'reminder' and reminder_ordinal > 0));
alter table private.operational_alert_outbox add constraint operational_alert_delivery_identity
  unique (episode_id, user_id, kind, reminder_ordinal);
create unique index operational_alert_one_outstanding_reminder
  on private.operational_alert_outbox(episode_id, user_id)
  where kind = 'reminder' and state in ('pending', 'sending');

-- A claim, refusal or uncertainty never qualifies a subscriber. Every actual
-- first/reminder attempt counts toward spacing; pending plans do not start it.
create function private.operational_alert_reminder_due(target_episode_id uuid, target_user_id uuid, observed_at timestamptz)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from private.operational_alert_outbox first_delivery
    where first_delivery.episode_id = target_episode_id and first_delivery.user_id = target_user_id
      and first_delivery.kind = 'first' and first_delivery.state = 'accepted'
      and greatest(first_delivery.finished_at, first_delivery.dispatch_started_at) <= observed_at - interval '24 hours'
  ) and not exists (
    select 1 from private.operational_alert_outbox previous
    where previous.episode_id = target_episode_id and previous.user_id = target_user_id
      and previous.kind in ('first', 'reminder')
      and (previous.dispatch_started_at > observed_at - interval '24 hours'
        or (previous.kind = 'reminder' and previous.state in ('sending', 'unknown')))
  );
$$;
revoke all on function private.operational_alert_reminder_due(uuid, uuid, timestamptz) from public, anon, authenticated, service_role;

-- Only unattempted active-episode mail is invalidated. Recovery belongs to the
-- resolved episode, even when that root has already acquired a new episode.
create or replace function private.close_resolved_operational_alerts(target_scopes uuid[], exports_only boolean default false)
returns void language sql security definer set search_path = '' as $$
  with resolved as (
    update private.operational_alert_episode episode set resolved_at = clock_timestamp()
    where resolved_at is null
      and (target_scopes is null or split_part(root_key, ':', 2)::uuid = any(target_scopes))
      and (not exports_only or kind = 'failed_company_export')
      and not private.operational_alert_root_is_active(root_key)
    returning id
  )
  update private.operational_alert_outbox delivery set state = 'cancelled', finished_at = clock_timestamp()
  where delivery.state = 'pending' and delivery.kind in ('first', 'reminder')
    and delivery.episode_id in (select id from resolved);
$$;

-- Keep #333's bounded commit-time observer and its queue-lock installation order.
create or replace function public.reconcile_operational_alerts(observed_at timestamptz default now())
returns jsonb language plpgsql security definer set search_path = '' as $$
declare candidate record;
begin
  if auth.role() <> 'service_role' then raise exception 'forbidden' using errcode = '42501'; end if;
  if observed_at is null then raise exception 'invalid observation' using errcode = '22023'; end if;
  if to_regclass('pgboss.job') is not null and not exists (select 1 from pg_trigger
      where tgrelid = to_regclass('pgboss.job') and tgname = 'alert_job_resolution') then
    perform pg_advisory_xact_lock(321, 2);
    if not exists (select 1 from pg_trigger where tgrelid = to_regclass('pgboss.job') and tgname = 'alert_job_resolution') then
      execute 'create trigger alert_job_resolution after insert or update or delete on pgboss.job for each row execute function private.observe_operational_alert_resolution()';
    end if;
  end if;
  perform pg_advisory_xact_lock(321, 1);
  perform private.close_resolved_operational_alerts();
  for candidate in select * from private.operational_alert_candidates() order by root_key loop
    insert into private.operational_alert_episode(root_key, kind, detail_href, impact, eligible_since, last_observed_at)
      values(candidate.root_key, candidate.kind, candidate.detail_href, candidate.impact, observed_at, observed_at)
      on conflict (root_key) where resolved_at is null do update
      set impact = excluded.impact, detail_href = excluded.detail_href,
        last_observed_at = greatest(operational_alert_episode.last_observed_at, excluded.last_observed_at);
  end loop;
  update private.operational_alert_outbox set state = 'unknown', finished_at = observed_at
    where state = 'sending' and dispatch_started_at <= observed_at - interval '2 minutes';
  insert into private.operational_alert_outbox(episode_id, user_id)
    select episode.id, preference.user_id from private.operational_alert_episode episode
    cross join private.operational_alert_preference preference
    where episode.resolved_at is null and episode.eligible_since <= observed_at - interval '5 minutes'
      and exists(select 1 from private.operational_alert_recipient(preference.user_id))
    on conflict do nothing;
  insert into private.operational_alert_outbox(episode_id, user_id, kind, reminder_ordinal)
    select episode.id, first_delivery.user_id, 'reminder',
      1 + (select coalesce(max(previous.reminder_ordinal), 0) from private.operational_alert_outbox previous
        where previous.episode_id = episode.id and previous.user_id = first_delivery.user_id and previous.kind = 'reminder')
    from private.operational_alert_episode episode
    join private.operational_alert_outbox first_delivery on first_delivery.episode_id = episode.id
      and first_delivery.kind = 'first' and first_delivery.state = 'accepted'
    where episode.resolved_at is null
      and private.operational_alert_reminder_due(episode.id, first_delivery.user_id, observed_at)
      and exists(select 1 from private.operational_alert_recipient(first_delivery.user_id))
      and not exists(select 1 from private.operational_alert_outbox outstanding
        where outstanding.episode_id = episode.id and outstanding.user_id = first_delivery.user_id
          and outstanding.kind = 'reminder' and outstanding.state in ('pending', 'sending'))
    on conflict do nothing;
  -- A late accepted first is discovered here even after synchronous resolution.
  -- Singleton identity makes duplicate ticks and process restarts harmless.
  insert into private.operational_alert_outbox(episode_id, user_id, kind)
    select episode.id, first_delivery.user_id, 'recovery'
    from private.operational_alert_episode episode
    join private.operational_alert_outbox first_delivery on first_delivery.episode_id = episode.id
      and first_delivery.kind = 'first' and first_delivery.state = 'accepted'
    where episode.resolved_at is not null
      and exists(select 1 from private.operational_alert_recipient(first_delivery.user_id))
    on conflict do nothing;
  return (select coalesce(jsonb_agg(id order by id), '[]'::jsonb) from private.operational_alert_outbox where state = 'pending');
end;
$$;

create or replace function public.claim_operational_alert(target_delivery_id uuid, observed_at timestamptz default now())
returns jsonb language plpgsql security definer set search_path = '' as $$
declare delivery private.operational_alert_outbox; episode private.operational_alert_episode;
  recipient record; candidate record; token uuid := gen_random_uuid();
  problem_kind text; detail_href text; impact jsonb;
begin
  if auth.role() <> 'service_role' then raise exception 'forbidden' using errcode = '42501'; end if;
  if observed_at is null then raise exception 'invalid observation' using errcode = '22023'; end if;
  perform pg_advisory_xact_lock(321, 1);
  select * into delivery from private.operational_alert_outbox where id = target_delivery_id for update;
  if not found or delivery.state <> 'pending' then return null; end if;
  select * into episode from private.operational_alert_episode where id = delivery.episode_id;
  select * into recipient from private.operational_alert_recipient(delivery.user_id);
  if not found then
    update private.operational_alert_outbox set state = 'cancelled', finished_at = observed_at where id = delivery.id;
    return null;
  end if;
  problem_kind := episode.kind;
  detail_href := episode.detail_href;
  impact := '{"companies":0,"documents":0,"sourceFiles":0,"exportJobs":0}'::jsonb;
  if delivery.kind = 'recovery' then
    if episode.resolved_at is null or not exists (
      select 1 from private.operational_alert_outbox first_delivery
      where first_delivery.episode_id = episode.id and first_delivery.user_id = delivery.user_id
        and first_delivery.kind = 'first' and first_delivery.state = 'accepted'
    ) then
      update private.operational_alert_outbox set state = 'cancelled', finished_at = observed_at where id = delivery.id;
      return null;
    end if;
  else
    if episode.resolved_at is not null then
      update private.operational_alert_outbox set state = 'cancelled', finished_at = observed_at where id = delivery.id;
      return null;
    end if;
    if episode.eligible_since > observed_at - interval '5 minutes'
      or (delivery.kind = 'reminder' and not private.operational_alert_reminder_due(episode.id, delivery.user_id, observed_at)) then
      return null;
    end if;
    select * into candidate from private.operational_alert_candidates() where root_key = episode.root_key;
    if not found then
      perform private.close_resolved_operational_alerts(array[split_part(episode.root_key, ':', 2)::uuid]);
      return null;
    end if;
    problem_kind := candidate.kind;
    detail_href := candidate.detail_href;
    impact := candidate.impact;
  end if;
  update private.operational_alert_outbox set state = 'sending', claim_token = token, dispatch_started_at = observed_at where id = delivery.id;
  return jsonb_build_object('id', delivery.id, 'claimToken', token, 'episodeId', episode.id,
    'email', recipient.email, 'locale', recipient.locale, 'kind', problem_kind,
    'deliveryKind', delivery.kind, 'detailHref', detail_href, 'impact', impact);
end;
$$;

create or replace function public.finish_operational_alert(target_delivery_id uuid, target_claim_token uuid, transport_outcome text, observed_at timestamptz default now())
returns void language plpgsql security definer set search_path = '' as $$
begin
  if auth.role() <> 'service_role' then raise exception 'forbidden' using errcode = '42501'; end if;
  if observed_at is null or transport_outcome not in ('accepted', 'refused', 'failed', 'unknown') or transport_outcome is null then
    raise exception 'invalid transport outcome' using errcode = '22023';
  end if;
  update private.operational_alert_outbox set state = transport_outcome,
    finished_at = greatest(observed_at, dispatch_started_at)
    where id = target_delivery_id and claim_token = target_claim_token and state in ('sending', 'unknown');
end;
$$;

create or replace function public.operational_alert_deliveries()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  if not private.can_administrate_platform() then raise exception 'forbidden' using errcode = '42501'; end if;
  return (select coalesce(jsonb_agg(jsonb_build_object('id', delivery.id, 'episodeId', episode.id,
    'rootKey', episode.root_key, 'kind', episode.kind, 'deliveryKind', delivery.kind,
    'reminderOrdinal', delivery.reminder_ordinal, 'state', delivery.state, 'eligibleSince', episode.eligible_since,
    'dispatchStartedAt', delivery.dispatch_started_at, 'finishedAt', delivery.finished_at,
    'resolvedAt', episode.resolved_at, 'impact', episode.impact)
    order by episode.eligible_since, delivery.kind, delivery.reminder_ordinal, delivery.id), '[]'::jsonb)
    from private.operational_alert_outbox delivery join private.operational_alert_episode episode on episode.id = delivery.episode_id
    where delivery.user_id = auth.uid());
end;
$$;
