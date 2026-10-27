"use client";

import Image from "next/image";
import Link from "next/link";
import { useActionState } from "react";
import { useTranslations } from "next-intl";
import {
  beginTotpEnrollmentAction,
  completeTotpEnrollmentAction,
} from "@/app/actions";
import { Button } from "@/components/button";
import { FormError } from "@/components/form-error";
import { TextField } from "@/components/text-field";

function CompleteEnrollment({
  enrollment,
}: {
  enrollment: {
    factorId: string;
    qrCode: string;
    secret: string;
  };
}) {
  const t = useTranslations("mfa");
  const [state, action, pending] = useActionState(completeTotpEnrollmentAction, {
    error: null,
    recoveryCodes: null,
  });
  if (state.recoveryCodes) {
    return (
      <section className="form">
        <h2>{t("recoveryCodesTitle")}</h2>
        <p>{t("recoveryCodesIntro")}</p>
        <ol className="recovery-codes">
          {state.recoveryCodes.map((code) => <li key={code}><code>{code}</code></li>)}
        </ol>
        <Link className="iv-btn iv-btn-primary iv-btn-md" href="/">{t("recoveryCodesSaved")}</Link>
      </section>
    );
  }
  return (
    <form action={action} className="form">
      <p>{t("scanIntro")}</p>
      <Image src={enrollment.qrCode} width={220} height={220} alt={t("qrAlt")} unoptimized />
      <p>{t("secretLabel")}: <code>{enrollment.secret}</code></p>
      <input type="hidden" name="factorId" value={enrollment.factorId} />
      <TextField label={t("codeLabel")} name="code" inputMode="numeric" autoComplete="one-time-code" required />
      <FormError error={state.error} />
      <Button variant="primary" type="submit" disabled={pending}>{t("verifyAndEnable")}</Button>
    </form>
  );
}

export function EnrollmentForm() {
  const t = useTranslations("mfa");
  const [state, action, pending] = useActionState(beginTotpEnrollmentAction, {
    error: null,
    enrollment: null,
  });
  if (state.enrollment) return <CompleteEnrollment enrollment={state.enrollment} />;
  return (
    <form action={action} className="form">
      <p>{t("enrollIntro")}</p>
      <FormError error={state.error} />
      <Button variant="primary" type="submit" disabled={pending}>{t("startEnrollment")}</Button>
    </form>
  );
}
