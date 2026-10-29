-- Readiness summaries count affected Documents, not individual findings. A
-- rejected Document is a resolved exclusion and stays separate from warnings.
create or replace function private.reporting_period_readiness_stats(
  target_company_id uuid,
  target_period text
)
returns jsonb
language sql stable security definer set search_path = ''
as $$
  with classified as (
    select
      document.status,
      document.status <> 'rejected'
        and (
          document.status in (
            'uploaded',
            'waiting_for_allowance',
            'waiting_for_platform',
            'processing',
            'failed',
            'needs_review'
          )
          or nullif(document.payload ->> 'direction', '') is null
          or nullif(document.payload ->> 'taxPointDate', '') is null
          or not (
            jsonb_typeof(document.payload -> 'rateBreakdown') = 'array'
            and jsonb_array_length(document.payload -> 'rateBreakdown') > 0
          )
          or nullif(document.payload ->> 'currency', '') is null
          or exists (
            select 1
            from jsonb_array_elements(coalesce(document.findings, '[]'::jsonb)) finding
            where finding ->> 'severity' = 'error'
          )
        ) as has_blocker,
      document.status not in (
        'uploaded',
        'waiting_for_allowance',
        'waiting_for_platform',
        'processing',
        'failed',
        'rejected'
      )
        and exists (
          select 1
          from jsonb_array_elements(coalesce(document.findings, '[]'::jsonb)) finding
          where finding ->> 'severity' = 'warning'
        ) as has_warning
    from private.reporting_period_readiness_documents(
      target_company_id,
      target_period
    ) document
  )
  select jsonb_build_object(
    'blockers', count(*) filter (where has_blocker),
    'warnings', count(*) filter (where has_warning),
    'rejectedDocuments', count(*) filter (where status = 'rejected')
  )
  from classified;
$$;

revoke execute on function private.reporting_period_readiness_stats(uuid, text)
  from public;

with current_counts as (
  select
    report.id,
    private.reporting_period_readiness_stats(report.company_id, report.period) as stats
  from public.vat_report report
)
update public.vat_report report
set
  blocker_count = (current_counts.stats ->> 'blockers')::integer,
  warning_count = (current_counts.stats ->> 'warnings')::integer,
  rejected_document_count = (current_counts.stats ->> 'rejectedDocuments')::integer
from current_counts
where current_counts.id = report.id;
