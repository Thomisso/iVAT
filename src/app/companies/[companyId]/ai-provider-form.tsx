"use client";

import { useActionState } from "react";
import { useTranslations } from "next-intl";
import {
  disableAiProcessingAction,
  enableAiProcessingAction,
  type FormState,
} from "@/app/actions";
import {
  companyAiOptionValue,
  type AiProcessingConsent,
  type CompanyAiOption,
} from "@/application/companies";
import { Button } from "@/components/button";
import { FormError } from "@/components/form-error";

export function AiProviderForm({
  companyId,
  options,
  current,
  setup = false,
}: {
  companyId: string;
  options: CompanyAiOption[];
  current: AiProcessingConsent;
  setup?: boolean;
}) {
  const [state, action, pending] = useActionState<FormState, FormData>(enableAiProcessingAction, {
    error: null,
    values: {},
  });
  const t = useTranslations("aiProcessing");
  const selected = state.values.option ?? (current
    ? companyAiOptionValue(current)
    : "");

  return (
    <form action={action} className="form" key={selected || "none"}>
      <input type="hidden" name="companyId" value={companyId} />
      {setup && <input type="hidden" name="returnTo" value="company" />}
      {options.length === 0 ? <p className="iv-muted">{t("noneAvailable")}</p> : <fieldset>
        <legend>{t("provider")}</legend>
        {options.map((option) => {
          const value = companyAiOptionValue(option);
          return <label className="iv-choice" key={value}>
            <input name="option" type="radio" value={value} defaultChecked={selected === value} required />
            <span>
              <strong>{option.provider}</strong>
              {" · "}{t(`source.${option.credentialSource}`)}{" · "}{option.region}
            </span>
          </label>;
        })}
      </fieldset>}
      {options.length > 0 && <label className="iv-choice">
        <input name="consent" type="checkbox" value="yes" defaultChecked={state.values.consent === "yes"} required />
        <span>{t("explicitConsent")}</span>
      </label>}
      <FormError error={state.error} />
      {options.length > 0 && <Button type="submit" variant="ai" icon="marker" disabled={pending}>
        {current ? t("change") : t("enable")}
      </Button>}
    </form>
  );
}

export function DisableAiProcessingForm({ companyId, setup = false }: { companyId: string; setup?: boolean }) {
  const [state, action, pending] = useActionState<FormState, FormData>(disableAiProcessingAction, {
    error: null,
    values: {},
  });
  const t = useTranslations("aiProcessing");
  return <form action={action} className="form">
    <input type="hidden" name="companyId" value={companyId} />
    {setup && <input type="hidden" name="returnTo" value="company" />}
    <FormError error={state.error} />
    <Button type="submit" variant="secondary" disabled={pending}>
      {setup ? t("skip") : t("disable")}
    </Button>
  </form>;
}
