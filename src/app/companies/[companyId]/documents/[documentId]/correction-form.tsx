"use client";

import { useActionState, useState, type ComponentProps } from "react";
import { useTranslations } from "next-intl";
import { correctDocumentAction } from "@/app/actions";
import {
  DIRECTIONS,
  DOCUMENT_TYPES,
  VAT_REGIMES,
  type ExtractionPayload,
} from "@/application/extraction-payload";
import { FormError } from "@/components/form-error";

/**
 * The extracted fields of one Extraction Version. While `editable`, saving
 * them records the User's corrections as the next version; otherwise they are
 * shown read-only.
 */
export function CorrectionForm({
  companyId,
  documentId,
  version,
  payload,
  editable,
}: {
  companyId: string;
  documentId: string;
  version: number;
  payload: ExtractionPayload;
  editable: boolean;
}) {
  const t = useTranslations("review");
  const [state, action, pending] = useActionState(correctDocumentAction, { error: null, values: {} });
  const [lines, setLines] = useState(() => payload.rateBreakdown.map((_, i) => i));
  const nextLine = Math.max(-1, ...lines) + 1;

  // A refused form shows what was submitted; otherwise the version's own value.
  const value = (name: string, saved: string | number | null) => state.values[name] ?? (saved === null ? "" : String(saved));

  const text = (name: string, saved: string | null, label = name, props: ComponentProps<"input"> = {}) => (
    <label key={name}>
      {t(`fields.${label}`)}
      <input name={name} defaultValue={value(name, saved)} disabled={!editable} {...props} />
    </label>
  );
  const date = (name: "issueDate" | "taxPointDate" | "dueDate") => text(name, payload[name], name, { type: "date" });
  const amount = (name: string, saved: string | null, label: string) =>
    text(name, saved, label, { inputMode: "decimal", className: "amount" });
  const choice = (name: string, saved: string | null, label: string, options: readonly string[], namespace: string) => (
    <label key={name}>
      {t(`fields.${label}`)}
      <select name={name} defaultValue={value(name, saved)} disabled={!editable}>
        <option value="">{t("notSet")}</option>
        {options.map((option) => (
          <option key={option} value={option}>
            {t(`${namespace}.${option}`)}
          </option>
        ))}
      </select>
    </label>
  );
  const party = (prefix: "supplier" | "customer") => (
    <fieldset>
      <legend>{t(`sections.${prefix}`)}</legend>
      <div className="fields">
        {(["name", "ico", "vatId", "street", "city", "postalCode", "country"] as const).map((name) =>
          text(`${prefix}.${name}`, payload[prefix][name], name),
        )}
      </div>
    </fieldset>
  );

  return (
    <form action={action} className="form correction-form">
      <input type="hidden" name="companyId" value={companyId} />
      <input type="hidden" name="documentId" value={documentId} />
      <input type="hidden" name="basedOnVersion" value={version} />
      <fieldset>
        <legend>{t("sections.document")}</legend>
        <div className="fields">
          {choice("documentType", payload.documentType, "documentType", DOCUMENT_TYPES, "documentType")}
          {text("documentNumber", payload.documentNumber)}
          {choice("direction", payload.direction, "direction", DIRECTIONS, "direction")}
          {choice("proposedVatRegime", payload.proposedVatRegime, "vatRegime", VAT_REGIMES, "vatRegime")}
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
              const cell = (name: "rate" | "netAmount" | "vatAmount") => (
                <td>
                  <input
                    name={`rateBreakdown.${line}.${name}`}
                    defaultValue={value(`rateBreakdown.${line}.${name}`, saved?.[name] ?? null)}
                    aria-label={t(`fields.${name}`)}
                    inputMode="decimal"
                    className="amount"
                    disabled={!editable}
                  />
                </td>
              );
              return (
                <tr key={line}>
                  {cell("rate")}
                  {cell("netAmount")}
                  {cell("vatAmount")}
                  {editable && (
                    <td>
                      <button type="button" onClick={() => setLines(lines.filter((l) => l !== line))}>
                        {t("removeRateLine")}
                      </button>
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
        {editable && (
          <button type="button" onClick={() => setLines([...lines, nextLine])}>
            {t("addRateLine")}
          </button>
        )}
        <div className="fields">
          {amount("totals.netAmount", payload.totals.netAmount, "totalNet")}
          {amount("totals.vatAmount", payload.totals.vatAmount, "totalVat")}
          {amount("totals.grossAmount", payload.totals.grossAmount, "totalGross")}
        </div>
      </fieldset>
      <fieldset>
        <legend>{t("sections.payment")}</legend>
        <div className="fields">
          {text("payment.variableSymbol", payload.payment.variableSymbol, "variableSymbol")}
          {text("payment.bankAccount", payload.payment.bankAccount, "bankAccount")}
          {text("payment.iban", payload.payment.iban, "iban")}
        </div>
      </fieldset>
      {editable && (
        <>
          <FormError error={state.error} />
          <button type="submit" disabled={pending}>
            {t("save")}
          </button>
        </>
      )}
    </form>
  );
}
