-- Credit Notes reduce a reported supply, so every amount they carry must be
-- negative at the human approval boundary. AI proposals may still reach review.

create function private.refuse_non_negative_credit_note_approval()
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
  if payload ->> 'documentType' <> 'credit_note' then
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

create trigger credit_note_amounts_before_approval
  before update of status on public.document
  for each row execute function private.refuse_non_negative_credit_note_approval();

revoke execute on function private.refuse_non_negative_credit_note_approval() from public;
