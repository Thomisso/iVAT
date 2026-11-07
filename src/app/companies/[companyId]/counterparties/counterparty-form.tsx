"use client";

import Link from "next/link";
import { useActionState } from "react";
import { useTranslations } from "next-intl";
import type { Counterparty } from "@/application/counterparties";
import { Button } from "@/components/button";
import { TextField } from "@/components/text-field";
import { FormError } from "@/components/form-error";
import { saveCounterpartyAction } from "./actions";

export function CounterpartyForm({ companyId, entry }: { companyId: string; entry?: Counterparty }) {
  const t = useTranslations("counterparties");
  const errors = useTranslations("errors");
  const [state, action, pending] = useActionState(saveCounterpartyAction, { error: null, values: {} });
  const values = { name: entry?.name ?? "", ico: entry?.ico ?? "", vatId: entry?.vatId ?? "",
    street: entry?.street ?? "", city: entry?.city ?? "", postalCode: entry?.postalCode ?? "",
    countryCode: entry?.countryCode ?? "", supplier: entry?.supplier ? "true" : "",
    customer: entry?.customer ? "true" : "", ...state.values };
  const fieldError = (...codes: string[]) => state.error && codes.includes(state.error) ? errors(state.error) : undefined;
  return <form action={action} className="form">
    <input type="hidden" name="companyId" value={companyId} />
    <input type="hidden" name="id" value={entry?.id ?? ""} />
    <FormError error={state.error} />
    {state.error === "counterparty_identity_taken" && <Link href={`/companies/${companyId}/counterparties?${new URLSearchParams({ state: "archived", ico: values.ico, vatId: values.vatId })}`}>{t("searchArchived")}</Link>}
    <TextField name="name" label={t("name")} defaultValue={values.name} maxLength={255} required error={fieldError("name_required", "name_too_long")} />
    <div className="form-row">
      <TextField name="ico" label={t("ico")} defaultValue={values.ico} error={fieldError("invalid_ico")} />
      <TextField name="vatId" label={t("vatId")} defaultValue={values.vatId} error={fieldError("counterparty_invalid_vat_id")} />
    </div>
    <TextField name="street" label={t("street")} defaultValue={values.street} />
    <div className="form-row">
      <TextField name="city" label={t("city")} defaultValue={values.city} />
      <TextField name="postalCode" label={t("postalCode")} defaultValue={values.postalCode} />
      <TextField name="countryCode" label={t("countryCode")} defaultValue={values.countryCode} maxLength={2} error={fieldError("invalid_country_code")} />
    </div>
    <fieldset>
      <legend>{t("roles")}</legend>
      <label className="iv-checkbox-row"><input type="checkbox" name="supplier" value="true" defaultChecked={values.supplier === "true"} /> {t("supplier")}</label>{" "}
      <label className="iv-checkbox-row"><input type="checkbox" name="customer" value="true" defaultChecked={values.customer === "true"} /> {t("customer")}</label>
    </fieldset>
    <div><Button variant="primary" type="submit" disabled={pending}>{pending ? t("saving") : t("save")}</Button></div>
  </form>;
}
