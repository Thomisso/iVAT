-- User-owned notification inbox state, scoped to the active Company.

alter table public.notification
  add column dismissed_at timestamptz;

create index notification_user_company_visible_idx
  on public.notification (user_id, company_id, created_at desc)
  where dismissed_at is null;

create function private.reopen_refreshed_upload_notification()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if new.kind = 'upload_batch_finished'
    and new.read_at is null
    and new.created_at is distinct from old.created_at then
    new.dismissed_at := null;
  end if;
  return new;
end;
$$;

create trigger reopen_refreshed_upload_notification
before update of created_at on public.notification
for each row execute function private.reopen_refreshed_upload_notification();

create function public.mark_company_upload_notifications_read(target_company_id uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  target public.company;
begin
  select * into target from public.company where id = target_company_id;
  if not found or not private.can_access_company(target.id, target.organization_id) then
    raise exception 'not allowed' using errcode = '42501';
  end if;

  update public.notification
  set read_at = coalesce(read_at, now())
  where user_id = auth.uid()
    and company_id = target.id
    and organization_id = target.organization_id
    and kind = 'upload_batch_finished'
    and dismissed_at is null;
end;
$$;

create function public.dismiss_upload_notification(target_notification_id uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  target public.notification;
begin
  select * into target
  from public.notification
  where id = target_notification_id
  for update;

  if not found
    or target.user_id <> auth.uid()
    or not private.can_access_company(target.company_id, target.organization_id) then
    raise exception 'not allowed' using errcode = '42501';
  end if;

  update public.notification
  set
    dismissed_at = coalesce(dismissed_at, now()),
    read_at = coalesce(read_at, now())
  where id = target.id;
end;
$$;

create function public.dismiss_company_upload_notifications(target_company_id uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  target public.company;
begin
  select * into target from public.company where id = target_company_id;
  if not found or not private.can_access_company(target.id, target.organization_id) then
    raise exception 'not allowed' using errcode = '42501';
  end if;

  update public.notification
  set
    dismissed_at = coalesce(dismissed_at, now()),
    read_at = coalesce(read_at, now())
  where user_id = auth.uid()
    and company_id = target.id
    and organization_id = target.organization_id
    and kind = 'upload_batch_finished'
    and dismissed_at is null;
end;
$$;

revoke execute on function public.mark_company_upload_notifications_read(uuid)
  from public, anon;
revoke execute on function public.dismiss_upload_notification(uuid)
  from public, anon;
revoke execute on function public.dismiss_company_upload_notifications(uuid)
  from public, anon;

grant execute on function public.mark_company_upload_notifications_read(uuid)
  to authenticated;
grant execute on function public.dismiss_upload_notification(uuid)
  to authenticated;
grant execute on function public.dismiss_company_upload_notifications(uuid)
  to authenticated;
