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
import type { ValidationFinding } from "@/application/document-validation";
import { Button } from "@/components/button";
import { TextField } from "@/components/text-field";
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
  findings,
  editable,
  aiProposed,
}: {
  companyId: string;
  documentId: string;
  version: number;
  payload: ExtractionPayload;
  findings: ValidationFinding[];
  editable: boolean;
  aiProposed?: boolean;
}) {
  const t = useTranslations("review");
  const [state, action, pending] = useActionState(correctDocumentAction, {
    error: null,
    values: {},
  });
  const [lines, setLines] = useState(() =>
    payload.rateBreakdown.map((_, i) => i),
  );
  const nextLine = Math.max(-1, ...lines) + 1;
  const finding = (field: string) =>
    findings.find(
      (item) => item.field === field && item.severity === "error",
    );
  const findingMessage = (field: string) => {
    const item = finding(field);
    return item
      ? t(`findings.${item.code}`, {
          difference: Number(item.params?.difference ?? 0),
        })
      : undefined;
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
    <TextField
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
    />
  );
  const date = (name: "issueDate" | "taxPointDate" | "dueDate") =>
    text(name, payload[name], name, { type: "date" });
  const amount = (name: string, saved: string | null, label: string) =>
    text(name, saved, label, { inputMode: "decimal" });
  const choice = (
    name: string,
    saved: string | null,
    label: string,
    options: readonly string[],
    namespace: string,
  ) => (
    <div className={`iv-field ${finding(name) ? "is-invalid" : ""}`} key={name}>
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
    </div>
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
      action={action}
      className={`form correction-form ${aiProposed ? "is-ai" : ""}`}
    >
      <input type="hidden" name="companyId" value={companyId} />
      <input type="hidden" name="documentId" value={documentId} />
      <input type="hidden" name="basedOnVersion" value={version} />
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
                  <input
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
                  {message && (
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
              {payload.czkConversion.rateBreakdown.map((line, index) => (
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
          <Button type="submit" disabled={pending}>
            {t("save")}
          </Button>
        </>
      )}
    </form>
  );
}
