-- EPO XML artifacts use the same monthly-or-quarterly Reporting Period format
-- as the VAT Reports whose immutable snapshots they preserve.

alter table public.vat_report_artifact
  drop constraint vat_report_artifact_period_check;
alter table public.vat_report_artifact
  add constraint vat_report_artifact_period_check check (
    period ~ '^20[0-9]{2}-(0[1-9]|1[0-2]|Q[1-4])$'
  );
