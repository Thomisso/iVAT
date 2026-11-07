"use client";

import { useActionState, useEffect, useId, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { updateDocumentReportingAction, type ReportingAssignmentFormState } from "@/app/actions";
import { Button } from "@/components/button";
import { FormError } from "@/components/form-error";
import { useReviewDraft } from "./review-guard";

const EMPTY_STATE: ReportingAssignmentFormState = { error: null, values: {} };

/** The independent Deferred Claim draft survives accounting-only refreshes. */
export function ReportingAssignmentForm({ companyId, documentId, claimedReportingPeriod, periods, available }: {
  companyId: string; documentId: string; claimedReportingPeriod: string | null; periods: readonly string[]; available: boolean;
}) {
  const t = useTranslations("review.reportingAssignment");
  const { registerReporting, reportingSettled, setPending, pending: sharedPending } = useReviewDraft() ?? {};
  const [result, action, pending] = useActionState(updateDocumentReportingAction, EMPTY_STATE);
  const [ignoredResult, setIgnoredResult] = useState<ReportingAssignmentFormState | null>(null);
  const state = result === ignoredResult ? EMPTY_STATE : result;
  const [handledResult, setHandledResult] = useState<ReportingAssignmentFormState | null>(null);
  const [base, setBase] = useState(claimedReportingPeriod ?? "");
  const [value, setValue] = useState(base);
  const [observed, setObserved] = useState(claimedReportingPeriod);
  const form = useRef<HTMLFormElement>(null);
  const reset = useRef<() => void>(() => {});
  const id = useId();
  if (result.savedReportingPeriod !== undefined && handledResult !== result) {
    setHandledResult(result);
    setBase(result.savedReportingPeriod ?? "");
    setValue(result.savedReportingPeriod ?? "");
  }
  if (observed !== claimedReportingPeriod) {
    setObserved(claimedReportingPeriod);
    // Another command may refresh the projection. Only a pristine draft
    // follows it; an edited selection is never replaced by that response.
    if (value === base && !pending && (result.savedReportingPeriod === undefined || handledResult === result)) {
      setBase(claimedReportingPeriod ?? "");
      setValue(claimedReportingPeriod ?? "");
    }
  }
  // Eligibility/status refreshes may remove the editor, never its dirty draft.
  const visible = available || value !== base;
  useEffect(() => {
    reset.current = () => {
      setIgnoredResult(result);
      setBase(claimedReportingPeriod ?? "");
      setValue(claimedReportingPeriod ?? "");
    };
  }, [result, claimedReportingPeriod]);
  useEffect(() => {
    if (form.current) return registerReporting?.(form.current, () => reset.current());
  }, [registerReporting, base, visible]);
  useEffect(() => {
    if (result.error !== null || result.savedReportingPeriod !== undefined) reportingSettled?.(result.error === null && result.savedReportingPeriod !== undefined);
  }, [result, reportingSettled]);
  useEffect(() => {
    setPending?.("reporting", pending);
    return () => setPending?.("reporting", false);
  }, [setPending, pending]);
  const busy = pending || sharedPending;
  if (!visible) return null;
  // Discard owns this controlled reset. React's automatic native reset must
  // not change the selection after its receipt establishes the guard baseline.
  return <form ref={form} action={action} className="form reporting-assignment-form" aria-busy={busy} onReset={event => event.preventDefault()}>
    <input type="hidden" name="companyId" value={companyId} />
    <input type="hidden" name="documentId" value={documentId} />
    <fieldset disabled={busy || !available}>
      <legend>{t("title")}</legend>
      <div className="fields"><div className="iv-field"><label className="iv-field-label" htmlFor={id}>{t("claimedReportingPeriod")}</label>
        <select id={id} className="iv-input" name="claimedReportingPeriod" value={value} aria-describedby={`${id}-hint`} onChange={event => setValue(event.target.value)}>
          <option value="">{t("defaultPeriod")}</option>
          {value && !periods.includes(value) && <option value={value}>{value}</option>}
          {periods.map(period => <option key={period} value={period}>{period}</option>)}
        </select>
        <small className="iv-field-hint" id={`${id}-hint`}>{t("claimedReportingPeriodHint")}</small>
      </div></div>
    </fieldset>
    {!available && <p role="status">{t("unavailable")}</p>}
    <FormError error={state.error} />
    {available && <Button type="submit" variant="primary" disabled={busy}>{pending ? t("saving") : t("save")}</Button>}
  </form>;
}
