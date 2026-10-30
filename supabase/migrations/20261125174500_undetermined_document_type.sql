-- An undetermined type is not an implicit Credit Note. SQL NULL must not
-- fall through the Credit Note-only sign guard.
create or replace function private.refuse_non_negative_credit_note_approval()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  payload jsonb;
  amount_text text;
  has_negative boolean := false;
begin
  if new.status <> 'approved' or old.status = 'approved' then
    return new;
  end if;
  select version.payload into payload
  from public.extraction_version version
  where version.document_id = new.id
  order by version.version desc
  limit 1;
  if payload ->> 'documentType' is distinct from 'credit_note' then
    return new;
  end if;
  for amount_text in
    select line ->> 'netAmount'
    from jsonb_array_elements(coalesce(payload -> 'rateBreakdown', '[]'::jsonb)) line
    union all
    select line ->> 'vatAmount'
    from jsonb_array_elements(coalesce(payload -> 'rateBreakdown', '[]'::jsonb)) line
    union all
    select payload -> 'totals' ->> 'netAmount'
    union all
    select payload -> 'totals' ->> 'vatAmount'
    union all
    select payload -> 'totals' ->> 'grossAmount'
  loop
    if amount_text is not null
      and (amount_text !~ '^-?[0-9]+\.[0-9]{2}$' or amount_text::numeric > 0) then
      raise exception 'Credit Note amounts must be negative'
        using errcode = 'P0001', hint = 'invalid_credit_note_amount';
    end if;
    has_negative := has_negative or coalesce(amount_text::numeric < 0, false);
  end loop;
  if not has_negative then
    raise exception 'Credit Note must reduce at least one amount'
      using errcode = 'P0001', hint = 'invalid_credit_note_amount';
  end if;
  return new;
end;
$$;
