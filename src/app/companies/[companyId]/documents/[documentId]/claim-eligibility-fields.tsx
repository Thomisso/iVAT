"use client";

import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import type { ExtractionPayload } from "@/application/extraction-payload";
import { ordinaryDomesticClaim } from "@/application/claim-eligibility";

/** A period confirmation, never an invented exact receipt date. */
export function ClaimEligibilityFields({ payload, periods, editable, values, error }: {
  payload: ExtractionPayload; periods: readonly string[]; editable: boolean; values: Record<string, string>; error?: string;
}) {
  const t = useTranslations("review.claimEligibility");
  const ref = useRef<HTMLFieldSetElement>(null);
  const observed = useRef(payload);
  const [source, setSource] = useState(payload);
  const [claim, setClaim] = useState(() => {
    try { return (values.claimEligibility ? JSON.parse(values.claimEligibility) : payload.claimEligibility) as ExtractionPayload["claimEligibility"]; }
    catch { return payload.claimEligibility; }
  });
  useEffect(() => {
    if (!editable) return;
    const form = ref.current?.form;
    if (!form) return;
    // DateInput commits its ISO hidden field in React's event handler. Observe
    // after that commit, rather than reading the preceding date at native bubble time.
    const read = () => {
      // Native pending protection excludes disabled fields from FormData.
      // It is not a human change to the eligibility basis.
      if (form.getAttribute("aria-busy") === "true") return;
      const data = new FormData(form);
      const value = (key: string) => String(data.get(key) ?? "").trim() || null;
      const previous = observed.current;
      const next = { ...previous, documentType: value("documentType") as ExtractionPayload["documentType"],
          direction: value("direction") as ExtractionPayload["direction"], proposedVatRegime: value("proposedVatRegime") as ExtractionPayload["proposedVatRegime"],
          issueDate: value("issueDate"), taxPointDate: value("taxPointDate") };
      if (["documentType", "direction", "proposedVatRegime", "issueDate", "taxPointDate"].some(key => previous[key as keyof ExtractionPayload] !== next[key as keyof ExtractionPayload]))
        setClaim(current => current ? { ...current, confirmed: false } : current);
      observed.current = next;
      setSource(next);
    };
    let frame = 0;
    const schedule = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(read); };
    form.addEventListener("input", schedule);
    form.addEventListener("change", schedule);
    return () => { cancelAnimationFrame(frame); form.removeEventListener("input", schedule); form.removeEventListener("change", schedule); };
  }, [editable]);
  const options = [...new Set([...(claim?.period ? [claim.period] : []), ...periods])].sort();
  return <fieldset ref={ref} hidden={!ordinaryDomesticClaim(source)}>
    <legend>{t("title")}</legend>
    {claim && <input type="hidden" name="claimEligibility" value={JSON.stringify(claim)} />}
    <div className="fields">
      <div className="iv-field">
        <label className="iv-field-label" htmlFor="earliest-claim-period">{t("period")}</label>
        <select id="earliest-claim-period" className="iv-input" aria-invalid={error ? true : undefined} aria-describedby={error ? "claim-eligibility-error" : undefined} value={claim?.period ?? ""} disabled={!editable}
          onChange={event => setClaim({ period: event.target.value, origin: "user", confirmed: false })}>
          <option value="">{t("unconfirmed")}</option>
          {options.map(period => <option key={period} value={period}>{period}</option>)}
        </select>
      </div>
      {error && <p id="claim-eligibility-error" className="iv-field-error">{error}</p>}
      <p>{claim?.confirmed ? t(claim.origin) : t("unconfirmed")}</p>
      <p>{t("hint")}</p>
      {editable && <label><input type="checkbox" checked={claim?.origin === "user" && claim.confirmed}
        disabled={!claim?.period} onChange={event => setClaim(current => current ? { period: current.period, origin: "user", confirmed: event.target.checked } : current)} /> {t("confirm")}</label>}
    </div>
  </fieldset>;
}
