"use client";

import { useActionState } from "react";
import { useTranslations } from "next-intl";
import { verifyRecoveryCodeAction, verifyTotpAction } from "@/app/actions";
import { Button } from "@/components/button";
import { FormError } from "@/components/form-error";
import { TextField } from "@/components/text-field";

const initialState = { error: null, values: {} };

export function VerificationForm() {
  const t = useTranslations("mfa");
  const [totpState, totpAction, totpPending] = useActionState(verifyTotpAction, initialState);
  const [recoveryState, recoveryAction, recoveryPending] = useActionState(verifyRecoveryCodeAction, initialState);
  return (
    <div className="form">
      <form action={totpAction} className="form">
        <TextField label={t("codeLabel")} name="code" inputMode="numeric" autoComplete="one-time-code" required />
        <FormError error={totpState.error} />
        <Button variant="primary" type="submit" disabled={totpPending}>{t("verify")}</Button>
      </form>
      <details>
        <summary>{t("useRecoveryCode")}</summary>
        <form action={recoveryAction} className="form">
          <TextField label={t("recoveryCodeLabel")} name="recoveryCode" autoComplete="one-time-code" required />
          <FormError error={recoveryState.error} />
          <Button variant="primary" type="submit" disabled={recoveryPending}>{t("verify")}</Button>
        </form>
      </details>
    </div>
  );
}
