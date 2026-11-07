"use client";

import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { normalizeExtractionPayload, type ExtractionPayload } from "@/application/extraction-payload";
import { claimBasis, claimBasisKey, partialClaimRates, unclaimedPortion } from "@/application/partial-claim";
import { Button } from "@/components/button";
import { TextField } from "@/components/text-field";

function formSource(form: HTMLFormElement, payload: ExtractionPayload): ExtractionPayload {
  const data = new FormData(form);
  const value = (name: string) => String(data.get(name) ?? "").trim() || null;
  const rows = [...new Set([...data.keys()].flatMap(key => /^rateBreakdown\.(\d+)\./.exec(key)?.[1] ?? []))].sort((a, b) => Number(a) - Number(b));
  return normalizeExtractionPayload({ ...payload, partialClaim: undefined,
    documentType: value("documentType") as ExtractionPayload["documentType"],
    direction: value("direction") as ExtractionPayload["direction"], currency: value("currency"),
    proposedVatRegime: value("proposedVatRegime") as ExtractionPayload["proposedVatRegime"], taxPointDate: value("taxPointDate"),
    rateBreakdown: rows.map(row => ({ rate: value(`rateBreakdown.${row}.rate`) === null ? null : Number(value(`rateBreakdown.${row}.rate`)?.replace(",", ".")),
      netAmount: value(`rateBreakdown.${row}.netAmount`), vatAmount: value(`rateBreakdown.${row}.vatAmount`) })),
    totals: { netAmount: value("totals.netAmount"), vatAmount: value("totals.vatAmount"), grossAmount: value("totals.grossAmount") },
  });
}

/** Human-only selection stays separate from the full source fields above it. */
export function PartialClaimFields({ payload, editable, values, rateRows }: { payload: ExtractionPayload; editable: boolean; values: Record<string, string>; rateRows: readonly number[] }) {
  const t = useTranslations("review");
  const ref = useRef<HTMLFieldSetElement>(null);
  const [source, setSource] = useState(payload);
  const [enabled, setEnabled] = useState(values["partialClaim.mode"] ? values["partialClaim.mode"] === "selected" : !!payload.partialClaim);
  const [selection, setSelection] = useState(() => ({
    netAmount: values["partialClaim.netAmount"] ?? payload.partialClaim?.rateBreakdown[0]?.netAmount ?? "",
    vatAmount: values["partialClaim.vatAmount"] ?? payload.partialClaim?.rateBreakdown[0]?.vatAmount ?? "",
    rate: payload.partialClaim?.rateBreakdown[0]?.rate ?? payload.rateBreakdown[0]?.rate ?? null,
  }));
  const [basis, setBasis] = useState(payload.partialClaim?.basis);
  const [confirmed, setConfirmed] = useState(payload.partialClaim?.confirmed ?? true);
  useEffect(() => {
    if (!editable) return;
    const form = ref.current?.form;
    if (!form) return;
    const read = (event: Event) => {
      const name = (event.target as HTMLInputElement).name;
      if (!name || name.startsWith("partialClaim.")) return;
      // Let React commit controlled/date input changes before reading the form.
      queueMicrotask(() => setSource(formSource(form, payload)));
    };
    // React Add/Remove actions change row structure without a native input event.
    queueMicrotask(() => setSource(formSource(form, payload)));
    form.addEventListener("input", read);
    form.addEventListener("change", read);
    return () => { form.removeEventListener("input", read); form.removeEventListener("change", read); };
  }, [payload, editable, rateRows]);
  const sourceRate = source.rateBreakdown.length === 1 ? source.rateBreakdown[0].rate : null;
  const changedRate = (sourceRate === 21 || sourceRate === 12) && sourceRate !== selection.rate;
  const savedSelection = payload.partialClaim?.rateBreakdown[0];
  const changedBasis = basis !== undefined && claimBasisKey(basis) !== claimBasisKey(source);
  const candidate = normalizeExtractionPayload({ ...source, partialClaim: { confirmed: confirmed && !changedBasis, basis, rateBreakdown: [selection] } });
  const remainder = enabled ? unclaimedPortion(candidate) : null;
  const valid = enabled && partialClaimRates(candidate) !== null;
  const activate = (checked: boolean) => {
    setEnabled(checked);
    if (checked) {
      const current = ref.current?.form ? formSource(ref.current.form, payload) : source;
      setSource(current);
      setSelection({ rate: current.rateBreakdown[0]?.rate ?? null, netAmount: current.rateBreakdown[0]?.netAmount ?? "", vatAmount: current.rateBreakdown[0]?.vatAmount ?? "" });
      setBasis(claimBasis(current)); setConfirmed(true);
    }
  };
  return <fieldset ref={ref}>
    <legend>{t("partialClaim.title")}</legend>
    <label><input type="checkbox" checked={enabled} disabled={!editable} onChange={event => activate(event.target.checked)} /> {t("partialClaim.enable")}</label>
    <input type="hidden" name="partialClaim.mode" value={enabled ? "selected" : payload.partialClaim ? "full" : "absent"} />
    {enabled && <>
      <p>{t("partialClaim.explanation")}</p>
      <input type="hidden" name="partialClaim.rate" value={selection.rate ?? ""} />
      <input type="hidden" name="partialClaim.confirmed" value={confirmed && !changedBasis ? "true" : "false"} />
      <input type="hidden" name="partialClaim.basis" value={basis ? JSON.stringify(basis) : ""} />
      <div className="fields">
        <TextField label={t("partialClaim.net")} name="partialClaim.netAmount" inputMode="decimal" mono value={selection.netAmount} disabled={!editable} onChange={event => setSelection({ ...selection, netAmount: event.target.value })} />
        <TextField label={t("partialClaim.vat")} name="partialClaim.vatAmount" inputMode="decimal" mono value={selection.vatAmount} disabled={!editable} onChange={event => setSelection({ ...selection, vatAmount: event.target.value })} />
      </div>
      {(!confirmed || changedBasis) && <p>{t("partialClaim.reconfirmation")}</p>}
      {(!confirmed || changedBasis) && savedSelection && <p className="amount">{t("partialClaim.previousSelection", {
        rate: savedSelection.rate ?? t("notSet"), net: savedSelection.netAmount ?? t("notSet"), vat: savedSelection.vatAmount ?? t("notSet"),
      })}</p>}
      {editable && (!confirmed || changedBasis) && <Button type="button" onClick={() => {
        // Rate reconciliation is part of this explicit human confirmation;
        // never rescale or replace the net/VAT amounts already entered.
        if (changedRate) setSelection({ ...selection, rate: sourceRate });
        setBasis(claimBasis(source)); setConfirmed(true);
      }}>{changedRate ? t("partialClaim.confirmRate", { rate: sourceRate }) : t("partialClaim.confirm")}</Button>}
      {!valid && <p role="alert">{t("findings.partial_claim_invalid")}</p>}
      <section role="region" aria-label={t("partialClaim.unclaimed")}>
        <h3>{t("partialClaim.unclaimed")}</h3>
        {remainder ? <dl><dt>{t("fields.netAmount")}</dt><dd className="amount">{remainder.netAmount}</dd><dt>{t("fields.vatAmount")}</dt><dd className="amount">{remainder.vatAmount}</dd><dt>{t("fields.totalGross")}</dt><dd className="amount">{remainder.grossAmount} {source.currency}</dd></dl> : <p>{t("partialClaim.unavailable")}</p>}
      </section>
    </>}
  </fieldset>;
}
