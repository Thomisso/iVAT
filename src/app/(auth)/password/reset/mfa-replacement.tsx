"use client";

import Image from "next/image";
import Link from "next/link";
import { useActionState } from "react";
import { useTranslations } from "next-intl";
import { beginBackupRecoveryAction, finishBackupRecoveryAction, resumeBackupRecoveryAction, startReplacementEnrollmentAction, verifyReplacementAuthenticatorAction } from "@/app/mfa-replacement-actions";
import type { MfaReplacementStatus } from "@/application/mfa-replacement";
import { Button } from "@/components/button";
import { FormError } from "@/components/form-error";
import { TextField } from "@/components/text-field";

const initial = { error: null, values: {} };

export function BackupRecoveryForm({ canResume = false }: { canResume?: boolean }) {
  const t = useTranslations("mfaRecovery");
  const mfa = useTranslations("mfa");
  const [state, action, pending] = useActionState(beginBackupRecoveryAction, initial);
  const [resume, resumeAction, resuming] = useActionState(resumeBackupRecoveryAction, initial);
  return <section className="form">
    <p>{t("codeIntro")}</p>
    {canResume && <form action={resumeAction} className="form">
      <FormError error={resume.error} />
      <Button type="submit" disabled={resuming || pending}>{t("resume")}</Button>
    </form>}
    <form action={action} className="form">
      <TextField label={mfa("recoveryCodeLabel")} name="code" autoComplete="one-time-code" required />
      <label><input type="checkbox" name="confirm" value="yes" required /> {t("confirmReplacement")}</label>
      <FormError error={state.error} />
      <Button type="submit" variant="primary" disabled={pending || resuming}>{t("useBackupCode")}</Button>
    </form>
  </section>;
}

function VerifyReplacementForm() {
  const t = useTranslations("mfaRecovery");
  const mfa = useTranslations("mfa");
  const [state, action, pending] = useActionState(verifyReplacementAuthenticatorAction, initial);
  return <form action={action} className="form">
    <TextField label={mfa("codeLabel")} name="code" autoComplete="one-time-code" inputMode="numeric" required />
    <FormError error={state.error} />
    <Button type="submit" variant="primary" disabled={pending}>{t("verifyReplacement")}</Button>
  </form>;
}

function ReplacementEnrollment({ existingFactor }: { existingFactor: boolean }) {
  const t = useTranslations("mfaRecovery");
  const mfa = useTranslations("mfa");
  const [state, action, pending] = useActionState(startReplacementEnrollmentAction, { error: null, enrollment: null });
  return <section className="form">
    <h2>{t("replacementTitle")}</h2>
    {state.enrollment ? <>
      <p>{mfa("scanIntro")}</p>
      <Image src={state.enrollment.qrCode.trimEnd()} width={220} height={220} alt={mfa("qrAlt")} unoptimized />
      <p>{mfa("secretLabel")}: <code>{state.enrollment.secret}</code></p>
      <VerifyReplacementForm />
    </> : <>
      {existingFactor && <><p>{t("continueSetup")}</p><VerifyReplacementForm /></>}
      <form action={action} className="form">
        <p>{t("replacementIntro")}</p>
        <FormError error={state.error} />
        <Button type="submit" disabled={pending}>{t(existingFactor ? "restartSetup" : "startSetup")}</Button>
      </form>
    </>}
  </section>;
}

function FinishReplacement({ passwordUpdated }: { passwordUpdated: boolean }) {
  const t = useTranslations("mfaRecovery");
  const recovery = useTranslations("passwordRecovery");
  const [state, action, pending] = useActionState(finishBackupRecoveryAction, initial);
  return <form action={action} className="form">
    <h2>{t("finishTitle")}</h2>
    <p>{t(passwordUpdated ? "passwordUpdated" : "finishIntro")}</p>
    {!passwordUpdated && <>
      <TextField label={recovery("newPassword")} name="newPassword" type="password" autoComplete="new-password" minLength={8} required />
      <TextField label={recovery("confirmation")} name="confirmation" type="password" autoComplete="new-password" minLength={8} required />
    </>}
    <FormError error={state.error} />
    <Button type="submit" variant="primary" disabled={pending}>{t("finish")}</Button>
  </form>;
}

export function MfaReplacementPanel({ status, canResume, emailVerified, nativeAal2 }: {
  status: MfaReplacementStatus; canResume: boolean; emailVerified: boolean; nativeAal2: boolean;
}) {
  const t = useTranslations("mfaRecovery");
  if (!status.authorized) return <section className="form">
    <p>{t("pendingUnauthorized")}</p>
    {emailVerified ? <BackupRecoveryForm canResume={canResume} /> : <Link href="/password/forgot">{t("startEmailRecovery")}</Link>}
  </section>;
  return <section className="form">
    <p role="status">{t("restricted")}</p><p>{t("preserveCodes")}</p>
    {status.factorVerified && nativeAal2
      ? <FinishReplacement passwordUpdated={status.passwordUpdated} />
      : <ReplacementEnrollment existingFactor={status.factorId !== null} />}
  </section>;
}
