"use client";

import { ReviewActions, useReviewWorkspace } from "./review-workspace";
import { useReviewDraft } from "./review-guard";
import { PartialClaimFields } from "./partial-claim-fields";
import { ClaimEligibilityFields } from "./claim-eligibility-fields";

import { SourceField, useSourceEvidence } from "./source-evidence-context";

import { useActionState, useEffect, useRef, useState, useId, type ComponentProps } from "react";
import { useTranslations } from "next-intl";
import { reviewDocumentAction, createManualDocumentAction, type DocumentReviewFormState } from "@/app/actions";
import {
  DIRECTIONS,
  DOCUMENT_TYPES,
  VAT_REGIMES,
  isZeroRateBreakdownLine,
  type ExtractionPayload,
} from "@/application/extraction-payload";
import type { ValidationFinding } from "@/application/document-validation";
import { findingMessage as messageOf } from "./finding-message";
import { Button } from "@/components/button";
import { TextField } from "@/components/text-field";
import { FormError } from "@/components/form-error";
import { DateInput } from "@/components/date-input";
import { CounterpartyLinkSummary } from "./counterparty-link-summary";
import { CounterpartyLinkFields } from "./counterparty-link-fields";
import { StatusBadge } from "@/components/status-badge";
import { statusBadgeState } from "@/components/status-badge-state";

/**
 * The extracted fields of one Extraction Version. While `editable`, saving
 * them records the User's corrections as the next version; otherwise they are
 * shown read-only.
 */
export function CorrectionForm({
  companyId,
  documentId,
  version: currentVersion,
  extractionVersionId,
  payload: currentPayload,
  findings: currentFindings,
  editable,
  aiProposed,
  requestId,
  displayedBankAccountCheckId,
  displayedReviewContext,
  currentCounterparty,
  decision,
  claimPeriods = [],
}: {
  companyId: string;
  documentId?: string;
  version: number;
  extractionVersionId?: string;
  payload: ExtractionPayload;
  findings: ValidationFinding[];
  editable: boolean;
  aiProposed?: boolean;
  requestId?: string;
  displayedBankAccountCheckId?: string | null;
  displayedReviewContext?: string;
  currentCounterparty?: ExtractionPayload["counterpartyLink"] | null;
  decision?: { nextDocumentId: string; queueQuery: string; returnTo: string };
  claimPeriods?: readonly string[];
}) {
  const t = useTranslations("review");
  const source = useSourceEvidence();
  const { register, settled } = useReviewDraft() ?? {};
  const workspace = useReviewWorkspace();
  const formId = useId();
  const form = useRef<HTMLFormElement>(null);
  const [state, action, pending] = useActionState<DocumentReviewFormState, FormData>(documentId ? reviewDocumentAction : createManualDocumentAction, {
    error: null,
    values: {},
  });
  // A Server Action may rerender the page with someone else's newer Version.
  // Keep this draft's base until our explicit save actually succeeds.
  const [base, setBase] = useState({ version: currentVersion, payload: currentPayload, findings: currentFindings, requestId, displayedBankAccountCheckId, displayedReviewContext, extractionVersionId });
  const { version, payload, findings } = base;
  const [direction, setDirection] = useState(payload.direction);
  const [clientErrors, setClientErrors] = useState<{ field: string; message: string }[]>([]);
  const [lines, setLines] = useState(() =>
    payload.rateBreakdown.flatMap((line, index) => isZeroRateBreakdownLine(line) ? [] : [index]),
  );
  if (state.savedVersion !== undefined && state.savedVersion === currentVersion && base.version !== currentVersion) {
    setBase({ version: currentVersion, payload: currentPayload, findings: currentFindings, requestId, displayedBankAccountCheckId, displayedReviewContext, extractionVersionId });
    setDirection(currentPayload.direction);
    setClientErrors([]);
    setLines(currentPayload.rateBreakdown.flatMap((line, index) => isZeroRateBreakdownLine(line) ? [] : [index]));
  } else if (base.version === currentVersion && (base.displayedBankAccountCheckId !== displayedBankAccountCheckId || base.displayedReviewContext !== displayedReviewContext)) {
    // An explicit same-Version refresh has rendered this dated observation.
    // Keep the draft's fields, Version and operation ID; another Version's
    // observation must never be adopted by this draft.
    setBase({ ...base, displayedBankAccountCheckId, displayedReviewContext });
  }
  useEffect(() => {
    if (source && source.version !== base.version) source.acceptBase(base.payload, base.version, base.extractionVersionId ?? "");
  }, [source, base.payload, base.version, base.extractionVersionId]);
  useEffect(() => {
    if (editable && form.current) return register?.(form.current);
  }, [register, version, editable]);
  useEffect(() => {
    if (state.error !== null || state.savedVersion !== undefined) settled?.(state.savedVersion !== undefined && state.error === null);
  }, [settled, state]);
  const setWorkspacePending = workspace?.setPending;
  useEffect(() => {
    setWorkspacePending?.(pending);
    return () => setWorkspacePending?.(false);
  }, [setWorkspacePending, pending]);
  const nextLine = Math.max(payload.rateBreakdown.length - 1, ...lines) + 1;
  const finding = (field: string) =>
    (state.findings ?? findings).find(
      (item) => item.field === field && item.severity === "error",
    );
  const findingMessage = (field: string) => {
    const item = finding(field);
    if (!item) return undefined;
    const message = messageOf(item);
    return t(`findings.${message.key}`, message.values);
  };

  // A refused form shows what was submitted; otherwise the version's own value.
  const value = (name: string, saved: string | number | null) =>
    state.values[name] ?? (saved === null ? "" : String(saved));

  const text = (
    name: string,
    saved: string | null,
    label = name,
    props: ComponentProps<"input"> = {},
  ) => (
    <SourceField key={name} field={name}><TextField
      key={name}
      label={t(`fields.${label}`)}
      name={name}
      defaultValue={value(name, saved)}
      disabled={!editable}
      error={findingMessage(name)}
      mono={/ico|vatId|[Nn]umber|[Aa]mount|[Ss]ymbol|iban|bankAccount/.test(
        name,
      )}
      {...props}
    /></SourceField>
  );
  const date = (name: "issueDate" | "taxPointDate" | "dueDate") => (
    <SourceField key={name} field={name}><DateInput
      key={name}
      label={t(`fields.${name}`)}
      name={name}
      defaultValue={value(name, payload[name])}
      disabled={!editable}
      error={findingMessage(name)}
      required={editable && name === "taxPointDate"}
    /></SourceField>
  );
  const amount = (name: string, saved: string | null, label: string) =>
    text(name, saved, label, { inputMode: "decimal" });
  const choice = (
    name: string,
    saved: string | null,
    label: string,
    options: readonly string[],
    namespace: string,
  ) => (
    <SourceField key={name} field={name}><div className={`iv-field ${finding(name) ? "is-invalid" : ""}`} key={name}>
      <label className="iv-field-label" htmlFor={`field-${name}`}>
        {t(`fields.${label}`)}
      </label>
      <select
        id={`field-${name}`}
        name={name}
        defaultValue={value(name, saved)}
        disabled={!editable}
        onChange={name === "direction" ? event => setDirection(event.target.value as ExtractionPayload["direction"]) : undefined}
        aria-invalid={finding(name) ? true : undefined}
        aria-describedby={finding(name) ? `finding-${name}` : undefined}
      >
        <option value="">{t("notSet")}</option>
        {options.map((option) => (
          <option key={option} value={option}>
            {t(`${namespace}.${option}`)}
          </option>
        ))}
      </select>
      {finding(name) && (
        <span id={`finding-${name}`} className="iv-field-error" role="alert">
          {findingMessage(name)}
        </span>
      )}
    </div></SourceField>
  );
  const party = (prefix: "supplier" | "customer") => (
    <fieldset>
      <legend>{t(`sections.${prefix}`)}</legend>
      <div className="fields">
        {(
          [
            "name",
            "ico",
            "vatId",
            "street",
            "city",
            "postalCode",
            "country",
          ] as const
        ).map((name) => text(`${prefix}.${name}`, payload[prefix][name], name))}
      </div>
    </fieldset>
  );
  const ownParty = direction === "incoming" ? "customer" : direction === "outgoing" ? "supplier" : null;
  const partyPanel = (prefix: "supplier" | "customer") => <details className="review-party" key={prefix} open={prefix !== ownParty}>
    <summary>{prefix === ownParty ? t("ownCompany", { name: payload[prefix].name ?? t("notSet") }) : t(`sections.${prefix}`)}</summary>
    {party(prefix)}
  </details>;
  const errors = (state.findings ?? findings).filter(item => item.severity === "error");
  const fieldLabel = (field: string) => {
    if (field === "claimEligibility") return t("claimEligibility.title");
    if (field === "partialClaim") return t("partialClaim.title");
    const labels: Record<string, string> = { proposedVatRegime: "vatRegime", "totals.netAmount": "totalNet", "totals.vatAmount": "totalVat", "totals.grossAmount": "totalGross", partialClaim: "totalNet" };
    const key = `fields.${labels[field] ?? field.split(".").at(-1)!}`;
    const label = t.has(key) ? t(key) : t("sections.document");
    return field.startsWith("supplier.") || field.startsWith("customer.") ? `${t(`sections.${field.split(".")[0]}`)} · ${label}` : label;
  };
  const focusField = (field: string) => {
    workspace?.showData();
    const wrapper = [...(form.current?.querySelectorAll<HTMLElement>("[data-source-field]") ?? [])].find(element => element.dataset.sourceField === field);
    const target = field === "claimEligibility" ? form.current?.querySelector<HTMLElement>("#earliest-claim-period")
      : wrapper?.querySelector<HTMLElement>('input:not([type="hidden"]):not([type="date"]),select')
        ?? [...(form.current?.elements ?? [])].find(element => element instanceof HTMLElement && element.getAttribute("name") === field) as HTMLElement | undefined;
    for (let parent = target?.parentElement; parent; parent = parent.parentElement) if (parent instanceof HTMLDetailsElement) parent.open = true;
    requestAnimationFrame(() => { target?.focus({ preventScroll: true }); target?.scrollIntoView({ block: "center" }); });
  };

  const comparisonRows = state.conflict ? Object.entries(state.values).flatMap(([name, submitted]) => {
    // Receipts, directory identities and validation bases are not editable fields.
    if (["companyId", "documentId", "basedOnVersion", "requestId", "displayedBankAccountCheckId", "displayedReviewContext", "acknowledgement", "intent", "nextDocumentId", "queueQuery", "returnTo", "counterpartyId", "partialClaim.basis"].includes(name)) return [];
    const currentPayload = state.conflict!.payload;
    const path = name.replace(/^partialClaim\.(\d+)\./, "partialClaim.rateBreakdown.$1.");
    const current = path.split(".").reduce<unknown>((entry, part) => entry !== null && typeof entry === "object" ? (entry as Record<string, unknown>)[part] : undefined, currentPayload);
    let saved = current === null || current === undefined ? "" : String(current);
    let entered = submitted;
    let label = fieldLabel(name);
    if (name === "claimEligibility") {
      const describe = (claim: ExtractionPayload["claimEligibility"]) => !claim?.period ? t("notSet")
        : `${claim.period} · ${claim.confirmed ? t(`claimEligibility.${claim.origin}`) : t("claimEligibility.unconfirmed")}`;
      try { entered = describe(JSON.parse(submitted) as ExtractionPayload["claimEligibility"]); }
      catch { entered = t("notSet"); }
      saved = describe(currentPayload.claimEligibility);
      label = t("claimEligibility.title");
    } else if (name === "partialClaim.mode") {
      label = t("partialClaim.title");
      entered = submitted === "selected" ? t("partialClaim.enable") : t("fullAmounts");
      saved = currentPayload.partialClaim ? t("partialClaim.enable") : t("fullAmounts");
    } else if (name === "partialClaim.confirmed" || name === "partialClaim.zeroConfirmed") {
      label = t(name.endsWith("zeroConfirmed") ? "partialClaim.zeroConfirm" : "selectionConfirmation");
      entered = t(submitted === "true" ? "confirmed" : "claimEligibility.unconfirmed");
      saved = t(current === true ? "confirmed" : "claimEligibility.unconfirmed");
    }
    return entered === saved ? [] : [{ name, label, entered: entered || t("notSet"), saved: saved || t("notSet") }];
  }) : [];


  return (
    <form
      key={version}
      ref={form}
      id={formId}
      action={action}
      aria-busy={pending}
      onInvalidCapture={event => {
        const input = event.target as HTMLInputElement;
        const field = input.closest<HTMLElement>("[data-source-field]")?.dataset.sourceField ?? input.name;
        if (!field) return;
        event.preventDefault();
        const message = input.validity.valueMissing ? t("requiredField") : input.validationMessage;
        setClientErrors(current => [...current.filter(item => item.field !== field), { field, message }]);
        if (!document.querySelector("dialog[open]")) focusField(field);
      }}
      onInputCapture={event => {
        const input = event.target as HTMLInputElement;
        const field = input.closest<HTMLElement>("[data-source-field]")?.dataset.sourceField ?? input.name;
        setClientErrors(current => current.some(item => item.field === field) ? current.filter(item => item.field !== field) : current);
      }}
      className={`form correction-form ${aiProposed ? "is-ai" : ""}`}
    >
      <fieldset disabled={pending} style={{ display: "contents" }}>
      <input type="hidden" name="companyId" value={companyId} />
      <input type="hidden" name="documentId" value={documentId} />
      <input type="hidden" name="basedOnVersion" value={version} />
      <input type="hidden" name="requestId" value={base.requestId ?? ""} />
      <input type="hidden" name="displayedBankAccountCheckId" value={base.displayedBankAccountCheckId ?? ""} />
      <input type="hidden" name="displayedReviewContext" value={base.displayedReviewContext ?? ""} />
      <input type="hidden" name="acknowledgement" value={state.confirmation?.id ?? ""} />
      {decision && Object.entries(decision).map(([name, entry]) => <input key={name} type="hidden" name={name} value={entry} />)}
      {(errors.length > 0 || clientErrors.length > 0) && <section role="region" aria-label={t("errorSummary")} className="review-error-summary">
        <h2>{t("errorSummary")}</h2><ul>{clientErrors.map(item => <li key={`client-${item.field}`}><button type="button" onClick={() => focusField(item.field)}>{fieldLabel(item.field)}: {item.message}</button></li>)}{errors.map((item, index) => { const message = messageOf(item); return <li key={`${item.field}-${item.code}-${index}`}><button type="button" onClick={() => focusField(item.field)}>{fieldLabel(item.field)}: {t(`findings.${message.key}`, message.values)}</button></li>; })}</ul>
      </section>}
      <fieldset>
        <legend>{t("sections.document")}</legend>
        <div className="fields">
          {choice(
            "documentType",
            payload.documentType,
            "documentType",
            DOCUMENT_TYPES,
            "documentType",
          )}
          {text("documentNumber", payload.documentNumber)}
          {choice(
            "direction",
            payload.direction,
            "direction",
            DIRECTIONS,
            "direction",
          )}
          {choice(
            "proposedVatRegime",
            payload.proposedVatRegime,
            "vatRegime",
            VAT_REGIMES,
            "vatRegime",
          )}
          {date("taxPointDate")}
        </div>
        <ClaimEligibilityFields key={`eligibility-${version}`} payload={payload} periods={claimPeriods} editable={editable} values={state.values} error={findingMessage("claimEligibility")} />
        <details className="review-infrequent"><summary>{t("otherDetails")}</summary><div className="fields">
          {text("reverseChargeCode", payload.reverseChargeCode, "reverseChargeCode", { maxLength: 3 })}
          {date("issueDate")}{date("dueDate")}
          {text("originalDocumentNumber", payload.originalDocumentNumber)}
        </div></details>

      </fieldset>
      <fieldset>
        <legend>{t("sections.amounts")}</legend>
        {text("currency", payload.currency, "currency", { maxLength: 3 })}
        <table className="rate-breakdown">
          <thead>
            <tr>
              <th>{t("fields.rate")}</th>
              <th>{t("fields.netAmount")}</th>
              <th>{t("fields.vatAmount")}</th>
              {editable && <th />}
            </tr>
          </thead>
          <tbody>
            {lines.map((line) => {
              const saved = payload.rateBreakdown[line];
              const cell = (name: "rate" | "netAmount" | "vatAmount") => {
                const field = `rateBreakdown.${line}.${name}`;
                const message = findingMessage(field);
                return (
                <td className={message ? "validation-cell is-invalid" : "validation-cell"}>
                  <SourceField field={field}><input
                    name={field}
                    defaultValue={value(
                      field,
                      saved?.[name] ?? null,
                    )}
                    aria-label={t(`fields.${name}`)}
                    aria-invalid={message ? true : undefined}
                    aria-describedby={message ? `finding-${field}` : undefined}
                    inputMode="decimal"
                    className="iv-input amount"
                    disabled={!editable}
                  />
                  </SourceField>{message && (
                    <span id={`finding-${field}`} className="iv-field-error" role="alert">
                      {message}
                    </span>
                  )}
                </td>
                );
              };
              return (
                <tr key={line}>
                  {cell("rate")}
                  {cell("netAmount")}
                  {cell("vatAmount")}
                  {editable && (
                    <td>
                      <Button
                        type="button"
                        size="sm"
                        onClick={() =>
                          setLines(lines.filter((l) => l !== line))
                        }
                      >
                        {t("removeRateLine")}
                      </Button>
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
        {editable && (
          <Button
            type="button"
            size="sm"
            onClick={() => setLines([...lines, nextLine])}
          >
            {t("addRateLine")}
          </Button>
        )}
        <div className="fields">
          {amount("totals.netAmount", payload.totals.netAmount, "totalNet")}
          {amount("totals.vatAmount", payload.totals.vatAmount, "totalVat")}
          {amount(
            "totals.grossAmount",
            payload.totals.grossAmount,
            "totalGross",
          )}
        </div>
      </fieldset>
      <PartialClaimFields key={version} payload={payload} editable={editable} values={state.values} rateRows={lines} />
      {payload.czkConversion && (
        <fieldset>
          <legend>{t("sections.czkConversion")}</legend>
          <p>
            {t("czkConversion.rate", {
              unit: payload.czkConversion.unit,
              currency: payload.czkConversion.originalCurrency,
              rate: payload.czkConversion.rate,
              date: payload.czkConversion.rateDate,
              source: payload.czkConversion.source,
            })}
          </p>
          <table className="rate-breakdown">
            <thead><tr><th>{t("fields.rate")}</th><th>{t("fields.netAmountCzk")}</th><th>{t("fields.vatAmountCzk")}</th></tr></thead>
            <tbody>
              {payload.czkConversion.rateBreakdown.filter((line) => !isZeroRateBreakdownLine(line)).map((line, index) => (
                <tr key={`${line.rate}-${index}`}>
                  <td>{line.rate}</td><td className="iv-mono">{line.netAmount}</td><td className="iv-mono">{line.vatAmount}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="iv-mono">
            {t("czkConversion.totals", {
              net: payload.czkConversion.totals.netAmount ?? t("notSet"),
              vat: payload.czkConversion.totals.vatAmount ?? t("notSet"),
              gross: payload.czkConversion.totals.grossAmount ?? t("notSet"),
            })}
          </p>
        </fieldset>
      )}
      <CounterpartyLinkSummary companyId={companyId} link={payload.counterpartyLink} />
      {editable && <CounterpartyLinkFields companyId={companyId} initialId={state.values.counterpartyId ?? payload.counterpartyLink?.id ?? ""} initialName={currentCounterparty?.recorded?.name ?? payload.counterpartyLink?.recorded?.name} currentDirectory={currentCounterparty} />}
      {direction === "outgoing" ? [partyPanel("customer"), partyPanel("supplier")] : [partyPanel("supplier"), partyPanel("customer")]}
      <fieldset>
        <legend>{t("sections.payment")}</legend>
        <div className="fields">
          {text(
            "payment.variableSymbol",
            payload.payment.variableSymbol,
            "variableSymbol",
          )}
          {text(
            "payment.bankAccount",
            payload.payment.bankAccount,
            "bankAccount",
          )}
          {text("payment.iban", payload.payment.iban, "iban")}
        </div>
      </fieldset>
      {editable && (
        <>
          <FormError error={state.error} />
          {state.confirmation && <section aria-label={t("preparedWarnings")} role="status">
            <p>{t("preparedWarnings")}</p>
            <ul>{state.confirmation.findings.filter((item) => item.severity === "warning").map((item) => {
              const message = messageOf(item);
              return <li key={`${item.field}-${item.code}`}>{t(`findings.${message.key}`, message.values)}</li>;
            })}</ul>
          </section>}
          {state.conflict && <section aria-label={t("compareCurrent")}>
            <h3>{t("compareVersion", { version: state.conflict.version })}</h3>
            <StatusBadge status={statusBadgeState(state.conflict.status, "document")} />
            <p>{t("submittedNotSaved")}</p>
            <table><thead><tr><th>{t("comparisonField")}</th><th>{t("submittedValue")}</th><th>{t("currentValue")}</th></tr></thead>
              <tbody>{comparisonRows.map(row => <tr key={row.name}><th>{row.label}</th><td>{row.entered}</td><td>{row.saved}</td></tr>)}</tbody>
            </table>
          </section>}
          <ReviewActions kind="save"><Button form={formId} type="submit" name="intent" value="save" disabled={pending}>
            {t(documentId ? "save" : "createManual")}
          </Button></ReviewActions>
          {documentId && decision && <ReviewActions kind="approve"><Button form={formId} type="submit" name="intent" value="approve" variant="primary" icon="check" disabled={pending}>
            {state.confirmation ? t("approvePreparedWarnings") : t("approve", { version })}
          </Button></ReviewActions>}
        </>
      )}
      </fieldset>
    </form>
  );
}
