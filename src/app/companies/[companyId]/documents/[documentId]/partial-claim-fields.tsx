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
  const [selection, setSelection] = useState(() => {
    const submitted = [...new Set(Object.keys(values).flatMap(key => /^partialClaim\.(\d+)\./.exec(key)?.[1] ?? []))].sort((a, b) => Number(a) - Number(b));
    return submitted.length ? submitted.map(i => ({ rate: values[`partialClaim.${i}.rate`] ? Number(values[`partialClaim.${i}.rate`].replace(",", ".")) : null,
      netAmount: values[`partialClaim.${i}.netAmount`] ?? "", vatAmount: values[`partialClaim.${i}.vatAmount`] ?? "" }))
      : (payload.partialClaim?.rateBreakdown ?? payload.rateBreakdown).map(line => ({ ...line, netAmount: line.netAmount ?? "", vatAmount: line.vatAmount ?? "" }));
  });
  const [zeroConfirmed, setZeroConfirmed] = useState(values["partialClaim.zeroConfirmed"] ? values["partialClaim.zeroConfirmed"] === "true" : payload.partialClaim?.zeroConfirmed ?? false);
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
      queueMicrotask(() => { if (form.getAttribute("aria-busy") !== "true") setSource(formSource(form, payload)); });
    };
    // React Add/Remove actions change row structure without a native input event.
    queueMicrotask(() => { if (form.getAttribute("aria-busy") !== "true") setSource(formSource(form, payload)); });
    form.addEventListener("input", read);
    form.addEventListener("change", read);
    return () => { form.removeEventListener("input", read); form.removeEventListener("change", read); };
  }, [payload, editable, rateRows]);
  const sourceRate = source.rateBreakdown.length === 1 ? source.rateBreakdown[0].rate : null;
  const changedRate = (sourceRate === 21 || sourceRate === 12) && selection.length === 1 && sourceRate !== selection[0].rate;
  const savedSelection = payload.partialClaim?.rateBreakdown;
  const changedBasis = basis !== undefined && claimBasisKey(basis) !== claimBasisKey(source);
  const candidate = normalizeExtractionPayload({ ...source, partialClaim: { confirmed: confirmed && !changedBasis, zeroConfirmed, basis, rateBreakdown: selection } });
  const zero = candidate.partialClaim?.rateBreakdown.length && candidate.partialClaim.rateBreakdown.every(line => line.netAmount === "0.00" && line.vatAmount === "0.00");
  const remainder = enabled ? unclaimedPortion(candidate) : null;
  const valid = enabled && partialClaimRates(candidate) !== null;
  const activate = (checked: boolean) => {
    setEnabled(checked);
    if (checked) {
      const current = ref.current?.form ? formSource(ref.current.form, payload) : source;
      setSource(current);
      setSelection(current.rateBreakdown.map(line => ({ ...line, netAmount: line.netAmount ?? "", vatAmount: line.vatAmount ?? "" })));
      setZeroConfirmed(false);
      setBasis(claimBasis(current)); setConfirmed(true);
    }
  };
  return <fieldset ref={ref}>
    <legend>{t("partialClaim.title")}</legend>
    <label><input type="checkbox" checked={enabled} disabled={!editable} onChange={event => activate(event.target.checked)} /> {t("partialClaim.enable")}</label>
    <input type="hidden" name="partialClaim.mode" value={enabled ? "selected" : payload.partialClaim ? "full" : "absent"} />
    {enabled && <>
      <p>{t("partialClaim.explanation")}</p>
      <input type="hidden" name="partialClaim.zeroConfirmed" value={zeroConfirmed ? "true" : "false"} />
      <input type="hidden" name="partialClaim.confirmed" value={confirmed && !changedBasis ? "true" : "false"} />
      <input type="hidden" name="partialClaim.basis" value={basis ? JSON.stringify(basis) : ""} />
      {selection.map((line, index) => <fieldset key={index}>
        <legend>{t("partialClaim.rate", { rate: line.rate ?? t("notSet") })}</legend>
        <div className="fields">
          <TextField label={t("fields.rate")} name={`partialClaim.${index}.rate`} inputMode="decimal" mono value={line.rate ?? ""} disabled={!editable}
            onChange={event => { setSelection(selection.map((row, i) => i === index ? { ...row, rate: event.target.value === "" ? null : Number(event.target.value.replace(",", ".")) } : row)); setZeroConfirmed(false); }} />
          <TextField label={t("partialClaim.net")} name={`partialClaim.${index}.netAmount`} inputMode="decimal" mono value={line.netAmount} disabled={!editable}
            onChange={event => { setSelection(selection.map((row, i) => i === index ? { ...row, netAmount: event.target.value } : row)); setZeroConfirmed(false); }} />
          <TextField label={t("partialClaim.vat")} name={`partialClaim.${index}.vatAmount`} inputMode="decimal" mono value={line.vatAmount} disabled={!editable}
            onChange={event => { setSelection(selection.map((row, i) => i === index ? { ...row, vatAmount: event.target.value } : row)); setZeroConfirmed(false); }} />
        </div>
        {editable && selection.length > 1 && <Button type="button" onClick={() => { setSelection(selection.filter((_, i) => i !== index)); setZeroConfirmed(false); }}>{t("partialClaim.removeRate")}</Button>}
      </fieldset>)}
      {editable && <Button type="button" onClick={() => { setSelection([...selection, { rate: null, netAmount: "", vatAmount: "" }]); setZeroConfirmed(false); }}>{t("partialClaim.addRate")}</Button>}
      {!!zero && <label><input type="checkbox" checked={zeroConfirmed} disabled={!editable} onChange={event => setZeroConfirmed(event.target.checked)} /> {t("partialClaim.zeroConfirm")}</label>}
      {(!confirmed || changedBasis) && <p>{t("partialClaim.reconfirmation")}</p>}
      {(!confirmed || changedBasis) && savedSelection?.map((line, index) => <p className="amount" key={index}>{t("partialClaim.previousSelection", {
        rate: line.rate ?? t("notSet"), net: line.netAmount ?? t("notSet"), vat: line.vatAmount ?? t("notSet"),
      })}</p>)}
      {editable && (!confirmed || changedBasis) && <Button type="button" onClick={() => {
        // Rate reconciliation is part of this explicit human confirmation;
        // never rescale or replace the net/VAT amounts already entered.
        if (changedRate) setSelection([{ ...selection[0], rate: sourceRate }]);
        setBasis(claimBasis(source)); setConfirmed(true);
      }}>{changedRate ? t("partialClaim.confirmRate", { rate: sourceRate }) : t("partialClaim.confirm")}</Button>}
      {!valid && <p role="alert">{t("findings.partial_claim_invalid")}</p>}
      <section role="region" aria-label={t("partialClaim.unclaimed")}>
        <h3>{t("partialClaim.unclaimed")}</h3>
        {remainder && <div>{remainder.rateBreakdown.map(line => <div key={line.rate}><p>{t("partialClaim.remainderRate", { rate: line.rate })}</p><dl>
          <dt>{t("fields.netAmount")}</dt><dd className="amount">{line.netAmount}</dd><dt>{t("fields.vatAmount")}</dt><dd className="amount">{line.vatAmount}</dd>
        </dl></div>)}</div>}
        {remainder ? <dl><dt>{t("fields.netAmount")}</dt><dd className="amount">{remainder.netAmount}</dd><dt>{t("fields.vatAmount")}</dt><dd className="amount">{remainder.vatAmount}</dd><dt>{t("fields.totalGross")}</dt><dd className="amount">{remainder.grossAmount} {source.currency}</dd></dl> : <p>{t("partialClaim.unavailable")}</p>}
      </section>
    </>}
  </fieldset>;
}
