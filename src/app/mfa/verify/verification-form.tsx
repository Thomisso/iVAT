"use client";

import { useActionState } from "react";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { verifyTotpAction } from "@/app/actions";
import { Button } from "@/components/button";
import { FormError } from "@/components/form-error";
import { TextField } from "@/components/text-field";

const initialState = { error: null, values: {} };

export function VerificationForm() {
  const t = useTranslations("mfa");
  const [totpState, totpAction, totpPending] = useActionState(verifyTotpAction, initialState);
  const recovery = useTranslations("mfaRecovery");
  return (
    <div className="form">
      <form action={totpAction} className="form">
        <TextField label={t("codeLabel")} name="code" inputMode="numeric" autoComplete="one-time-code" required />
        <FormError error={totpState.error} />
        <Button variant="primary" type="submit" disabled={totpPending}>{t("verify")}</Button>
      </form>
      <p>{recovery("loginIntro")} <Link href="/password/forgot">{recovery("startEmailRecovery")}</Link></p>
    </div>
  );
}
