-- Preserve the latest accounting preparation helper, including feature keys
-- installed by earlier directory/claim/period migrations. Carry only a row
-- identity map through it; source references are inherited below at insertion.
alter function private.document_manual_review_payload(jsonb, jsonb)
  rename to document_manual_review_payload_before_evidence;
create function private.document_manual_review_payload(base jsonb, candidate jsonb)
returns jsonb language sql immutable security definer set search_path = '' as $$
  select private.document_manual_review_payload_before_evidence(base, candidate)
    || case when candidate ? 'sourceRateRows' then jsonb_build_object('sourceRateRows', candidate -> 'sourceRateRows') else '{}'::jsonb end;
$$;
revoke all on function private.document_manual_review_payload(jsonb, jsonb) from public, anon, authenticated, service_role;

-- All manual entry paths, including direct correct_document and combined
-- approval, converge here. This mechanism changes evidence only; it never
-- reconstructs or whitelists the financial payload of another feature.
create function private.bind_extraction_source_evidence()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  doc public.document;
  source_hash text;
  source_format text;
  base_payload jsonb;
  evidence jsonb;
  fields jsonb := '{}'::jsonb;
  entry record;
  path text;
  old_index integer;
  new_index integer;
  row_map jsonb;
  map_valid boolean := false;
  base_count integer;
  new_count integer;
begin
  select * into doc from public.document where id = new.document_id;
  select sha256, format::text into source_hash, source_format from public.source_file where id = doc.source_file_id;
  if new.author_user_id is null then
    evidence := new.payload -> 'sourceEvidence';
  else
    row_map := new.payload -> 'sourceRateRows';
    new.payload := new.payload - 'sourceEvidence' - 'sourceLocations' - 'sourceRateRows' - 'confidence';
    select payload into base_payload from public.extraction_version
      where document_id = new.document_id and version < new.version order by version desc limit 1;
    evidence := base_payload -> 'sourceEvidence';
    base_count := jsonb_array_length(coalesce(base_payload -> 'rateBreakdown', '[]'::jsonb));
    new_count := jsonb_array_length(coalesce(new.payload -> 'rateBreakdown', '[]'::jsonb));
    if row_map is null and base_count = new_count then
      select coalesce(jsonb_agg(i), '[]'::jsonb) into row_map from generate_series(0, new_count - 1) i;
    end if;
    if jsonb_typeof(row_map) = 'array' and jsonb_array_length(row_map) = new_count then
      map_valid := not exists (select 1 from jsonb_array_elements(row_map) x where x <> 'null'::jsonb
        and (jsonb_typeof(x) <> 'number' or x::text !~ '^[0-9]+$'));
      if map_valid then
        map_valid := not exists (select 1 from jsonb_array_elements(row_map) x where x <> 'null'::jsonb and (x::text::numeric >= base_count))
          and (select count(*) = count(distinct x) from jsonb_array_elements(row_map) x where x <> 'null'::jsonb);
      end if;
    end if;
    if jsonb_typeof(evidence -> 'fields') = 'object' then
      for entry in select * from jsonb_each(evidence -> 'fields') loop
        path := entry.key;
        if path ~ '^rateBreakdown\.[0-9]+\.' then
          if not map_valid then continue; end if;
          old_index := split_part(path, '.', 2)::integer;
          select (ordinality - 1)::integer into new_index from jsonb_array_elements(row_map) with ordinality m(value, ordinality)
            where value <> 'null'::jsonb and value::text::numeric = old_index;
          if new_index is null then continue; end if;
          path := 'rateBreakdown.' || new_index || '.' || split_part(path, '.', 3);
        end if;
        if (new.payload #> string_to_array(path, '.')) is distinct from (base_payload #> string_to_array(entry.key, '.')) then
          entry.value := jsonb_set(entry.value, '{origin}', '"manual"'::jsonb);
        end if;
        fields := fields || jsonb_build_object(path, entry.value);
      end loop;
      evidence := jsonb_set(evidence, '{fields}', fields);
    end if;
  end if;
  -- A reference cannot switch Sources or oriented bases, even through an RPC.
  -- Missing/invalid evidence is removed without rejecting financial data.
  if jsonb_typeof(evidence) = 'object' and source_format = 'pdf'
    and evidence ->> 'schemaVersion' = '1'
    and evidence ->> 'sourceFileId' = doc.source_file_id::text
    and evidence ->> 'documentId' = new.document_id::text
    and evidence ->> 'sourceSha256' = source_hash
    and evidence #>> '{basis,kind}' = 'original'
    and evidence #>> '{basis,format}' = 'pdf'
    and evidence #>> '{basis,sha256}' = source_hash
    and evidence #>> '{range,firstPage}' = doc.first_page::text
    and evidence #>> '{range,lastPage}' = doc.last_page::text
    and jsonb_typeof(evidence -> 'fields') = 'object' then
    new.payload := jsonb_set(new.payload, '{sourceEvidence}', jsonb_set(evidence, '{extractionVersionId}', to_jsonb(new.id::text)));
  else
    new.payload := new.payload - 'sourceEvidence';
  end if;
  new.payload := new.payload - 'sourceLocations' - 'sourceRateRows';
  return new;
end;
$$;
revoke all on function private.bind_extraction_source_evidence() from public, anon, authenticated, service_role;
create trigger bind_extraction_source_evidence before insert on public.extraction_version
  for each row execute function private.bind_extraction_source_evidence();
