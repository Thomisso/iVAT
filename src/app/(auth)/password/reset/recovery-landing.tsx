"use client";

import Link from "next/link";
import { useActionState, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { recoverPasswordAction, recoveryLinkStatusAction, verifyPasswordRecoveryAction, verifyRecoveryAuthenticatorAction } from "@/app/password-recovery-actions";
import { Button } from "@/components/button";
import { FormError } from "@/components/form-error";
import { TextField } from "@/components/text-field";

const initial = { error: null, values: {} };

function VerifyRecoveryLink({ requestToken, tokenHash }: { requestToken: string; tokenHash: string }) {
  const t = useTranslations("passwordRecovery");
  const [state, action, pending] = useActionState(verifyPasswordRecoveryAction, initial);
  useEffect(() => {
    if (state.complete) window.location.replace(window.location.pathname);
  }, [state.complete]);
  return <form action={action} className="form">
    <p>{t("verifyIntro")}</p>
    <input type="hidden" name="requestToken" value={requestToken} />
    <input type="hidden" name="tokenHash" value={tokenHash} />
    <FormError error={state.error} />
    <Button type="submit" variant="primary" disabled={pending || state.complete}>{t("verifyEmail")}</Button>
  </form>;
}

function RecoveryAuthenticatorForm() {
  const t = useTranslations("passwordRecovery");
  const mfa = useTranslations("mfa");
  const [state, action, pending] = useActionState(verifyRecoveryAuthenticatorAction, initial);
  return <form action={action} className="form">
    <p>{t("authenticatorIntro")}</p>
    <TextField label={mfa("codeLabel")} name="code" autoComplete="one-time-code" inputMode="numeric" required />
    <FormError error={state.error} />
    <Button type="submit" variant="primary" disabled={pending}>{t("verifyAuthenticator")}</Button>
  </form>;
}

function RecoveryPasswordForm() {
  const t = useTranslations("passwordRecovery");
  const [state, action, pending] = useActionState(recoverPasswordAction, initial);
  if (state.complete) return <><p role="status">{t("complete")}</p><Link href="/">{t("continue")}</Link></>;
  return <form action={action} className="form">
    <TextField label={t("newPassword")} name="newPassword" type="password" autoComplete="new-password" minLength={8} required />
    <TextField label={t("confirmation")} name="confirmation" type="password" autoComplete="new-password" minLength={8} required />
    <FormError error={state.error} />
    <Button type="submit" variant="primary" disabled={pending}>{t("savePassword")}</Button>
  </form>;
}

export function RecoveryLanding({ sessionStatus, needsAuthenticator }: {
  sessionStatus: "ready" | "complete" | "invalid" | "used" | "expired"; needsAuthenticator: boolean;
}) {
  const t = useTranslations("passwordRecovery");
  const [link, setLink] = useState<{ requestToken: string; tokenHash: string; status: string } | null>(null);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    let disposed = false;
    let generation = 0;
    const load = () => {
      const request = ++generation;
      const parameters = new URLSearchParams(window.location.hash.slice(1));
      const requestToken = parameters.get("request") ?? "";
      const tokenHash = parameters.get("token_hash") ?? "";
      if (!requestToken && !tokenHash) { setLink(null); setLoaded(true); return; }
      recoveryLinkStatusAction(requestToken).then(status => {
        if (!disposed && request === generation) { setLink({ requestToken, tokenHash, status }); setLoaded(true); }
      }).catch(() => {
        if (!disposed && request === generation) { setLink({ requestToken: "", tokenHash: "", status: "invalid" }); setLoaded(true); }
      });
    };
    const changed = () => { setLoaded(false); load(); };
    load();
    window.addEventListener("hashchange", changed);
    return () => { disposed = true; generation++; window.removeEventListener("hashchange", changed); };
  }, []);
  if (!loaded) return <p role="status">{t("loading")}</p>;
  if (!link && sessionStatus === "complete") return <><p role="status">{t("complete")}</p><Link href="/">{t("continue")}</Link></>;
  if (!link && sessionStatus === "ready") return needsAuthenticator ? <RecoveryAuthenticatorForm /> : <RecoveryPasswordForm />;
  const status = link?.status ?? sessionStatus;
  return <>
    {status === "valid" && link ? <VerifyRecoveryLink requestToken={link.requestToken} tokenHash={link.tokenHash} /> : <FormError error={`recovery_link_${status}`} />}
    <p><Link href="/password/forgot">{t("requestAgain")}</Link></p>
  </>;
}
