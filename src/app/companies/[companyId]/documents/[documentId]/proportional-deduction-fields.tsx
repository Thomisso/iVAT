"use client";

import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import type { ExtractionPayload } from "@/application/extraction-payload";
import { claimBasis, claimBasisKey } from "@/application/partial-claim";
import { validatedDocumentCzkConversion } from "@/application/exchange-rates";
import { proportionalDeductionSummary } from "@/application/proportional-deduction";
import { Button } from "@/components/button";
import { Money } from "@/components/money";
import { TextField } from "@/components/text-field";
import { formSource } from "./partial-claim-fields";

/** This legal decision is always explicit and human, including its two scope confirmations. */
export function ProportionalDeductionFields({ payload, editable, values, rateRows }: {
  payload: ExtractionPayload; editable: boolean; values: Record<string, string>; rateRows: readonly number[];
}) {
  const t = useTranslations("review.proportionalDeduction");
  const ref = useRef<HTMLFieldSetElement>(null);
  const saved = payload.proportionalDeduction;
  const [source, setSource] = useState(payload);
  const [enabled, setEnabled] = useState(values["proportionalDeduction.mode"] ? values["proportionalDeduction.mode"] === "proportional" : !!saved);
  const [percentage, setPercentage] = useState(values["proportionalDeduction.percentage"] ?? String(saved?.percentage ?? ""));
  const [operating, setOperating] = useState(values["proportionalDeduction.operatingExpenseConfirmed"] ? values["proportionalDeduction.operatingExpenseConfirmed"] === "true" : saved?.operatingExpenseConfirmed ?? false);
  const [actual, setActual] = useState(values["proportionalDeduction.actualUseConfirmed"] ? values["proportionalDeduction.actualUseConfirmed"] === "true" : saved?.actualUseConfirmed ?? false);
  const [confirmed, setConfirmed] = useState(values["proportionalDeduction.confirmed"] ? values["proportionalDeduction.confirmed"] === "true" : saved?.confirmed ?? false);
  const [basis, setBasis] = useState(() => {
    if (!("proportionalDeduction.basis" in values)) return saved?.basis;
    try { return values["proportionalDeduction.basis"] ? JSON.parse(values["proportionalDeduction.basis"]) as NonNullable<ExtractionPayload["proportionalDeduction"]>["basis"] : undefined; }
    catch { return undefined; }
  });
  useEffect(() => {
    if (!editable) return;
    const form = ref.current?.form;
    if (!form) return;
    const read = () => queueMicrotask(() => {
      if (form.getAttribute("aria-busy") !== "true") {
        const current = formSource(form, payload);
        const data = new FormData(form);
        // A conflicting selection is displayed as invalid and refused by the database.
        setSource({ ...current, partialClaim: data.get("partialClaim.mode") === "selected" ? { confirmed: false, rateBreakdown: [] } : undefined });
      }
    });
    read();
    form.addEventListener("input", read); form.addEventListener("change", read);
    return () => { form.removeEventListener("input", read); form.removeEventListener("change", read); };
  }, [payload, editable, rateRows]);
  const changed = (() => {
    try { return basis !== undefined && claimBasisKey(basis) !== claimBasisKey(source); }
    catch { return true; }
  })();
  const candidate: ExtractionPayload = { ...source, proportionalDeduction: { percentage: /^\d+$/.test(percentage) ? Number(percentage) : null,
    confirmed: confirmed && !changed, operatingExpenseConfirmed: operating, actualUseConfirmed: actual, origin: "user", ...(basis ? { basis } : {}) } };
  const summary = enabled ? proportionalDeductionSummary(candidate) : null;
  const claimed = summary?.rateBreakdown;
  const remainder = summary?.unclaimed;
  return <fieldset ref={ref} id="proportional-deduction" tabIndex={-1}>
    <legend>{t("title")}</legend>
    <label><input id="proportional-deduction-enabled" type="checkbox" checked={enabled} disabled={!editable}
      onChange={event => { setEnabled(event.target.checked); if (event.target.checked && !saved) setConfirmed(false); }} /> {t("enable")}</label>
    <input type="hidden" name="proportionalDeduction.mode" value={enabled ? "proportional" : saved ? "full" : "absent"} />
    {enabled && <>
      <p>{t("scope")}</p><p>{t("rounding")}</p>
      {source.currency && source.currency !== "CZK" && <><p>{t("conversion")}</p>
        {!validatedDocumentCzkConversion(source) && <p role="alert">{t("conversionRequired")}</p>}</>}
      <TextField label={t("percentage")} name="proportionalDeduction.percentage" inputMode="numeric" mono value={percentage} disabled={!editable}
        onChange={event => { setPercentage(event.target.value); setConfirmed(false); }} />
      <label><input type="checkbox" checked={operating} disabled={!editable} onChange={event => { setOperating(event.target.checked); setConfirmed(false); }} /> {t("operating")}</label>
      <label><input type="checkbox" checked={actual} disabled={!editable} onChange={event => { setActual(event.target.checked); setConfirmed(false); }} /> {t("actual")}</label>
      <input type="hidden" name="proportionalDeduction.operatingExpenseConfirmed" value={String(operating)} />
      <input type="hidden" name="proportionalDeduction.actualUseConfirmed" value={String(actual)} />
      <input type="hidden" name="proportionalDeduction.confirmed" value={String(confirmed && !changed)} />
      <input type="hidden" name="proportionalDeduction.basis" value={basis ? JSON.stringify(basis) : ""} />
      {saved && (!confirmed || changed) && <p>{t("previous", { percentage: saved.percentage ?? "" })}</p>}
      {editable && (!confirmed || changed) && <Button type="button" disabled={!operating || !actual || !/^[1-9][0-9]?$/.test(percentage)}
        onClick={() => { setBasis(claimBasis(source)); setConfirmed(true); }}>{t("confirm")}</Button>}
      {!claimed && <p role="alert">{t("invalid")}</p>}
      <p>{t("alternatives")}</p>
      {claimed && <table><thead><tr><th>{t("rate")}</th><th>{t("original")}</th><th>{t("claimed")}</th><th>{t("unclaimed")}</th></tr></thead>
        <tbody>{source.rateBreakdown.map(line => {
          const selected = claimed.find(row => row.rate === line.rate)!;
          const rest = remainder?.rateBreakdown.find(row => row.rate === line.rate);
          return <tr key={line.rate}><th>{t("rateValue", { rate: line.rate ?? "" })}</th>
            {[line, selected, rest].map((row, index) => <td className="amount" key={index}>{row?.netAmount != null && row?.vatAmount != null
              ? <><Money amount={row.netAmount} currency={source.currency ?? ""} /> {t("amountSeparator")} <Money amount={row.vatAmount} currency={source.currency ?? ""} /></> : t("unavailable")}</td>)}
          </tr>;
        })}</tbody><tfoot><tr><th>{t("total")}</th>
          {[source.totals, summary, remainder].map((row, index) => <td className="amount" key={index}>{row?.netAmount != null && row?.vatAmount != null
            ? <><Money amount={row.netAmount} currency={source.currency ?? ""} /> {t("amountSeparator")} <Money amount={row.vatAmount} currency={source.currency ?? ""} /></> : t("unavailable")}</td>)}
        </tr></tfoot></table>}
      <p>{t("filing")}</p>
    </>}
  </fieldset>;
}
