insert into public.platform_user (user_id, role)
  select id, 'super_admin'::public.platform_role
  from auth.users
  where lower(email) = lower('tomas.masopust@me.com')
  on conflict (user_id)
  do update set role = excluded.role;