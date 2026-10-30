-- Upload Batch history filtered by Reporting Period (QA v3, #119).
-- A batch matches when it holds at least one current Document of the period;
-- an omitted (null) period matches Documents without a Reporting Period.
-- Security invoker: RLS on upload_batch, source_file and document still applies.

create index source_file_upload_batch_id_idx on public.source_file (upload_batch_id);

create function public.upload_batches_in_reporting_period(
  target_company_id uuid,
  target_period text default null
)
returns setof public.upload_batch
language sql
stable
security invoker
set search_path = ''
as $$
  select b.*
  from public.upload_batch b
  where b.company_id = target_company_id
    and exists (
      select 1
      from public.source_file s
      join public.document_overview d on d.source_file_id = s.id
      where s.upload_batch_id = b.id
        and d.reporting_period is not distinct from target_period
    );
$$;

revoke execute on function public.upload_batches_in_reporting_period(uuid, text) from public, anon;
grant execute on function public.upload_batches_in_reporting_period(uuid, text) to authenticated;
