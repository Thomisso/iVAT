"use client";

import { useState, type FormEvent } from "react";
import type { PersonType } from "@/application/companies";
import { useTranslations } from "next-intl";
import { EPO_FORMATS, TAX_OFFICES } from "@/application/epo-export-details";
import { TextField } from "@/components/text-field";
import { Button } from "@/components/button";
import { FormError } from "@/components/form-error";

export function ExportForm({
  companyId,
  period,
  preparedOn,
  personType,
}: {
  companyId: string;
  period: string;
  preparedOn: string;
  personType: PersonType;
}) {
  const t = useTranslations("epoExport");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function download(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setPending(true);
    setError(null);
    try {
      const response = await fetch(
        `/companies/${companyId}/vat-reports/${period}/xml`,
        { method: "POST", body: form },
      );
      if (response.redirected) {
        window.location.assign(response.url);
        return;
      }
      if (!response.ok) {
        const failure = await response.json();
        setError(
          [
            "report_not_found",
            "invalid_export_format",
            "invalid_export_details",
            "xml_invalid",
          ].includes(failure.error)
            ? failure.error
            : "export_failed",
        );
        return;
      }
      if (
        !response.headers.get("Content-Type")?.startsWith("application/xml")
      ) {
        setError("export_failed");
        return;
      }
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement("a");
      link.href = url;
      link.download = `${String(form.get("format")).toUpperCase()}-${period}.xml`;
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch {
      setError("export_failed");
    } finally {
      setPending(false);
    }
  }

  return (
    <section>
      <h2>{t("title")}</h2>
      <p className="iv-muted">{t("description")}</p>
      <form className="form" onSubmit={download}>
        <div className="form-row">
          <label className="iv-field-label">
            {t("format")}
            <select name="format" defaultValue="dphdp3">
              {EPO_FORMATS.map((format) => (
                <option key={format} value={format}>
                  {t(`formats.${format}`)}
                </option>
              ))}
            </select>
          </label>
          <TextField
            type="date"
            label={t("preparedOn")}
            name="preparedOn"
            required
            defaultValue={preparedOn}
          />
        </div>
        <label className="iv-field-label">
          {t("taxOffice")}
          <select name="taxOffice" required defaultValue="">
            <option value="">{t("choose")}</option>
            {TAX_OFFICES.map((code) => (
              <option key={code} value={code}>
                {t(`taxOffices.${code}`)}
              </option>
            ))}
          </select>
        </label>
        <p>
          {t("personType")}: {t(personType === "legal" ? "legalPerson" : "naturalPerson")}
        </p>
        {personType === "legal" && (
          <fieldset>
            <legend>{t("signatory")}</legend>
            <div className="form-row">
              <TextField
                label={t("firstName")}
                name="signatoryFirstName"
                required
                maxLength={20}
              />
              <TextField
                label={t("lastName")}
                name="signatoryLastName"
                required
                maxLength={36}
              />
            </div>
            <TextField
              label={t("capacity")}
              name="signatoryCapacity"
              required
              maxLength={40}
            />
          </fieldset>
        )}
        <TextField
          label={t("email")}
          name="email"
          type="email"
          maxLength={255}
        />
        <FormError error={error} />
        <Button type="submit" disabled={pending} icon="report">
          {t(pending ? "preparing" : "download")}
        </Button>
      </form>
    </section>
  );
}
