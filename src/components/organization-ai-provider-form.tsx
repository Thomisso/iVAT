"use client";

import { useActionState } from "react";
import { useTranslations } from "next-intl";
import {
  removeOrganizationAiProviderKeyAction,
  saveOrganizationAiProviderKeyAction,
  type FormState,
} from "@/app/actions";
import type { OrganizationAiProviderKey } from "@/application/organization-ai";
import { Button } from "@/components/button";
import { FormError } from "@/components/form-error";
import { TextField } from "@/components/text-field";

const INITIAL_STATE: FormState = { error: null, values: {} };

export function OrganizationAiProviderForm({
  organizationId,
  settings,
}: {
  organizationId: string;
  settings: OrganizationAiProviderKey;
}) {
  const [saveState, saveAction, saving] = useActionState(
    saveOrganizationAiProviderKeyAction,
    INITIAL_STATE,
  );
  const [removeState, removeAction, removing] = useActionState(
    removeOrganizationAiProviderKeyAction,
    INITIAL_STATE,
  );
  const t = useTranslations("organizationAi");
  return (
    <section className="iv-card">
      <h2>{settings.provider}</h2>
      <p className="iv-muted">
        {settings.hasOrganizationKey
          ? t("keyStored", { lastFour: settings.organizationKeyLastFour ?? "????" })
          : t("keyMissing")}
      </p>
      <form action={saveAction} className="form">
        <input type="hidden" name="organizationId" value={organizationId} />
        <input type="hidden" name="provider" value={settings.provider} />
        <TextField
          name="apiKey"
          type="password"
          label={t("apiKey")}
          autoComplete="new-password"
          required
        />
        <label className="iv-checkbox">
          <input
            type="checkbox"
            name="dpaAcknowledged"
            defaultChecked={saveState.values.dpaAcknowledged === "on"}
            required
          />
          {t("dpaWarning", { provider: settings.provider })}
        </label>
        <FormError error={saveState.error} />
        <Button type="submit" variant="primary" disabled={saving}>
          {t("save")}
        </Button>
      </form>
      {settings.hasOrganizationKey && (
        <form action={removeAction} className="form">
          <input type="hidden" name="organizationId" value={organizationId} />
          <input type="hidden" name="provider" value={settings.provider} />
          <FormError error={removeState.error} />
          <Button type="submit" variant="ghost" disabled={removing}>
            {t("remove")}
          </Button>
        </form>
      )}
    </section>
  );
}
