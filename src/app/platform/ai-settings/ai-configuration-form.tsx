"use client";

import { useActionState } from "react";
import { useTranslations } from "next-intl";
import {
  createAiConfigurationAction,
  type FormState,
  updateAiConfigurationAction,
} from "@/app/actions";
import type { AiConfigurationSummary } from "@/application/ai-configurations";
import { Button } from "@/components/button";
import { FormError } from "@/components/form-error";
import { TextField } from "@/components/text-field";

export function AiConfigurationForm({
  providers,
  configuration,
}: {
  providers: string[];
  configuration?: AiConfigurationSummary;
}) {
  const serverAction = configuration ? updateAiConfigurationAction : createAiConfigurationAction;
  const [state, action, pending] = useActionState<FormState, FormData>(serverAction, {
    error: null,
    values: {},
  });
  const t = useTranslations("platformAi");
  const provider = state.values.provider ?? configuration?.provider ?? providers[0] ?? "";

  return (
    <form action={action} className="form ai-configuration-form">
      {configuration && <input type="hidden" name="configurationId" value={configuration.id} />}
      <TextField
        name="label"
        label={t("configurationLabel")}
        defaultValue={state.values.label ?? configuration?.label ?? ""}
        required
      />
      <div className="iv-field">
        <label className="iv-field-label" htmlFor={`provider-${configuration?.id ?? "new"}`}>
          {t("provider")}
        </label>
        <select
          id={`provider-${configuration?.id ?? "new"}`}
          name="provider"
          className="iv-input"
          defaultValue={provider}
          required
        >
          {providers.map((candidate) => <option key={candidate} value={candidate}>{candidate}</option>)}
        </select>
      </div>
      <TextField
        name="splitModel"
        label={t("splitModel")}
        defaultValue={state.values.splitModel ?? ""}
        required
        mono
      />
      <TextField
        name="extractModel"
        label={t("extractModel")}
        defaultValue={state.values.extractModel ?? ""}
        required
        mono
      />
      <TextField
        name="credential"
        type="password"
        label={t("configurationCredential")}
        hint={configuration
          ? t("configurationCredentialStored", { lastFour: configuration.credentialLastFour })
          : t("configurationCredentialRequired")}
        required={!configuration}
        autoComplete="new-password"
      />
      <FormError error={state.error} />
      <Button type="submit" variant="primary" disabled={pending}>
        {configuration ? t("updateConfiguration") : t("createConfiguration")}
      </Button>
    </form>
  );
}
