"use client";

import { Fragment, useActionState } from "react";
import { useTranslations } from "next-intl";
import { setAiModelPricesAction, type FormState } from "@/app/actions";
import type { AiConfigurationSummary, AiModelPrice } from "@/application/ai-configurations";
import { Button } from "@/components/button";
import { FormError } from "@/components/form-error";
import { TextField } from "@/components/text-field";

export function AiModelPricesForm({
  configuration,
  models,
}: {
  configuration: AiConfigurationSummary;
  models: AiModelPrice[];
}) {
  const [state, action, pending] = useActionState<FormState, FormData>(setAiModelPricesAction, {
    error: null,
    values: {},
  });
  const t = useTranslations("platformAi");

  return (
    <form action={action} className="form settings-form" aria-label={t("modelPricesFor", { label: configuration.label })}>
      <input type="hidden" name="configurationId" value={configuration.id} />
      <p className="iv-muted">{t("modelPricesIntro")}</p>
      {models.map((price) => (
        <Fragment key={price.model}>
          <input type="hidden" name="model" value={price.model} />
          <TextField
            name="inputPricePerMillion"
            label={t("inputPrice", { model: price.model })}
            inputMode="decimal"
            defaultValue={state.values[`inputPricePerMillion:${price.model}`] ?? price.inputPricePerMillion ?? ""}
          />
          <TextField
            name="outputPricePerMillion"
            label={t("outputPrice", { model: price.model })}
            inputMode="decimal"
            defaultValue={state.values[`outputPricePerMillion:${price.model}`] ?? price.outputPricePerMillion ?? ""}
          />
        </Fragment>
      ))}
      <FormError error={state.error} />
      <Button type="submit" variant="primary" disabled={pending}>{t("saveModelPrices")}</Button>
    </form>
  );
}
