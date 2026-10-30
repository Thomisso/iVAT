-- A selected period or an absent date cannot stand in for a manually entered
-- Tax Point Date. Preserve incomplete AI proposals; guard every User Version.
create function private.valid_document_tax_point_date(candidate text)
returns boolean
language plpgsql immutable security definer set search_path = ''
as $$
begin
  if candidate is null or candidate !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then return false; end if;
  return candidate::date::text = candidate;
exception when datetime_field_overflow or invalid_datetime_format then
  return false;
end;
$$;
revoke execute on function private.valid_document_tax_point_date(text) from public;

create function private.require_manual_tax_point_date()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if new.author_user_id is null then return new; end if;
  if coalesce(new.payload ->> 'schemaVersion', '') not in ('1', '2') or (
    new.payload ->> 'schemaVersion' = '1' and exists (
      select 1 from jsonb_array_elements(new.payload -> 'rateBreakdown') line
      where jsonb_typeof(line -> 'rate') is distinct from 'number'
        or jsonb_typeof(line -> 'netAmount') is distinct from 'string'
        or jsonb_typeof(line -> 'vatAmount') is distinct from 'string'
    )
  ) then
    raise exception 'incomplete rows require payload version 2'
      using errcode = 'P0001', hint = 'invalid_choice';
  end if;
  if nullif(new.payload ->> 'taxPointDate', '') is null then
    raise exception 'a manual save requires a Tax Point Date'
      using errcode = 'P0001', hint = 'tax_point_date_required';
  end if;
  if not private.valid_document_tax_point_date(new.payload ->> 'taxPointDate') then
    raise exception 'invalid Tax Point Date' using errcode = 'P0001', hint = 'invalid_date';
  end if;
  return new;
end;
$$;
revoke execute on function private.require_manual_tax_point_date() from public;
create trigger extraction_version_manual_tax_point_date
  before insert on public.extraction_version
  for each row execute function private.require_manual_tax_point_date();
