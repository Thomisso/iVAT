-- Keep the editable upload limit within the static Storage and Next transport
-- ceiling, while allowing SuperAdmins to raise it above the original 20 MiB.

create or replace function public.set_platform_upload_limits(
  target_max_source_file_bytes bigint,
  target_max_source_file_pages integer,
  target_max_upload_batch_files integer
)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  if not private.can_administrate_platform() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if target_max_source_file_bytes <= 0
    or target_max_source_file_bytes > 50 * 1024 * 1024
    or target_max_source_file_pages <= 0
    or target_max_upload_batch_files <= 0 then
    raise exception 'invalid upload limits'
      using errcode = 'P0001', hint = 'invalid_upload_limits';
  end if;
  update public.platform_settings
  set max_source_file_bytes = target_max_source_file_bytes,
      max_source_file_pages = target_max_source_file_pages,
      max_upload_batch_files = target_max_upload_batch_files
  where singleton;
end;
$$;
