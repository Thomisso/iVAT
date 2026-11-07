"use client";

import { SourceField } from "./source-evidence-context";

import { useActionState, useState, type ComponentProps } from "react";
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
  payload: currentPayload,
  findings: currentFindings,
  editable,
  aiProposed,
  requestId,
  displayedBankAccountCheckId,
  decision,
}: {
  companyId: string;
  documentId?: string;
  version: number;
  payload: ExtractionPayload;
  findings: ValidationFinding[];
  editable: boolean;
  aiProposed?: boolean;
  requestId?: string;
  displayedBankAccountCheckId?: string | null;
  decision?: { nextDocumentId: string; queueQuery: string; returnTo: string };
}) {
  const t = useTranslations("review");
  const [state, action, pending] = useActionState<DocumentReviewFormState, FormData>(documentId ? reviewDocumentAction : createManualDocumentAction, {
    error: null,
    values: {},
  });
  // A Server Action may rerender the page with someone else's newer Version.
  // Keep this draft's base until our explicit save actually succeeds.
  const [base, setBase] = useState({ version: currentVersion, payload: currentPayload, findings: currentFindings, requestId, displayedBankAccountCheckId });
  const { version, payload, findings } = base;
  const [lines, setLines] = useState(() =>
    payload.rateBreakdown.flatMap((line, index) => isZeroRateBreakdownLine(line) ? [] : [index]),
  );
  if (state.savedVersion !== undefined && state.savedVersion === currentVersion && base.version !== currentVersion) {
    setBase({ version: currentVersion, payload: currentPayload, findings: currentFindings, requestId, displayedBankAccountCheckId });
    setLines(currentPayload.rateBreakdown.flatMap((line, index) => isZeroRateBreakdownLine(line) ? [] : [index]));
  } else if (base.version === currentVersion && base.displayedBankAccountCheckId !== displayedBankAccountCheckId) {
    // An explicit same-Version refresh has rendered this dated observation.
    // Keep the draft's fields, Version and operation ID; another Version's
    // observation must never be adopted by this draft.
    setBase({ ...base, displayedBankAccountCheckId });
  }
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

  return (
    <form
      key={version}
      action={action}
      className={`form correction-form ${aiProposed ? "is-ai" : ""}`}
    >
      <input type="hidden" name="companyId" value={companyId} />
      <input type="hidden" name="documentId" value={documentId} />
      <input type="hidden" name="basedOnVersion" value={version} />
      <input type="hidden" name="requestId" value={base.requestId ?? ""} />
      <input type="hidden" name="displayedBankAccountCheckId" value={base.displayedBankAccountCheckId ?? ""} />
      <input type="hidden" name="acknowledgement" value={state.confirmation?.id ?? ""} />
      {decision && Object.entries(decision).map(([name, entry]) => <input key={name} type="hidden" name={name} value={entry} />)}
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
          {text("reverseChargeCode", payload.reverseChargeCode, "reverseChargeCode", {
            maxLength: 3,
          })}
          {date("issueDate")}
          {date("taxPointDate")}
          {date("dueDate")}
          {text("currency", payload.currency, "currency", { maxLength: 3 })}
          {text("originalDocumentNumber", payload.originalDocumentNumber)}
        </div>
      </fieldset>
      {party("supplier")}
      {party("customer")}
      <fieldset>
        <legend>{t("sections.amounts")}</legend>
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
              <tbody>{Object.entries(state.values).filter(([name]) => !["companyId", "documentId", "basedOnVersion", "requestId", "displayedBankAccountCheckId", "acknowledgement", "intent", "nextDocumentId", "queueQuery", "returnTo"].includes(name)).map(([name, submitted]) => {
                const current = name.split(".").reduce<unknown>((entry, part) => entry !== null && typeof entry === "object" ? (entry as Record<string, unknown>)[part] : undefined, state.conflict!.payload);
                const saved = current === null || current === undefined ? "" : String(current);
                const labels: Record<string, string> = { proposedVatRegime: "vatRegime", "totals.netAmount": "totalNet", "totals.vatAmount": "totalVat", "totals.grossAmount": "totalGross" };
                const label = labels[name] ?? name.split(".").at(-1)!;
                return submitted !== saved ? <tr key={name}><th>{t(`fields.${label}`)}</th><td>{submitted || t("notSet")}</td><td>{saved || t("notSet")}</td></tr> : null;
              })}</tbody>
            </table>
          </section>}
          <Button type="submit" name="intent" value="save" disabled={pending}>
            {t(documentId ? "save" : "createManual")}
          </Button>
          {documentId && decision && <Button type="submit" name="intent" value="approve" variant="primary" icon="check" disabled={pending}>
            {state.confirmation ? t("approvePreparedWarnings") : t("approve", { version })}
          </Button>}
        </>
      )}
    </form>
  );
}
