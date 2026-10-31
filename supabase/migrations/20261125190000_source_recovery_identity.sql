-- Source work has its own request identity before any Document exists.
alter type public.source_file_status add value if not exists 'rejected';
alter type public.source_file_status add value if not exists 'needs_review';
alter table public.source_file
  add column split_request_id uuid not null default gen_random_uuid(),
  add column manual_definition jsonb,
  add column manually_defined_at timestamptz,
  add column manually_defined_by uuid references auth.users(id) on delete set null,
  add column exclusion_reason text,
  add column excluded_at timestamptz,
  add column excluded_by uuid references auth.users(id) on delete set null,
  add constraint source_exclusion_reason_length check (
    exclusion_reason is null or length(trim(exclusion_reason)) between 1 and 500
  );
