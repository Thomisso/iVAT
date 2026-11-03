"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { loadInvitationAction, signOutInvitationAction } from "@/app/actions";
import { Button } from "@/components/button";
import { FormError } from "@/components/form-error";
import { AcceptInvitationForm } from "./accept-invitation-form";

type LoadedInvitation = Awaited<ReturnType<typeof loadInvitationAction>>;

export function InvitationLanding({ legacyToken }: { legacyToken: string }) {
  const t = useTranslations("members");
  const [token, setToken] = useState("");
  const [loaded, setLoaded] = useState<LoadedInvitation | null>(null);
  const [failed, setFailed] = useState(false);
  const [signOutError, setSignOutError] = useState<string | null>(null);
  useEffect(() => {
    let disposed = false;
    let generation = 0;
    const load = () => {
      const request = ++generation;
      const value = new URLSearchParams(window.location.hash.slice(1)).get("token") ?? legacyToken;
      const form = new FormData();
      form.set("token", value);
      loadInvitationAction(form).then(result => {
        if (!disposed && request === generation) { setToken(value); setLoaded(result); }
      }).catch(() => { if (!disposed && request === generation) setFailed(true); });
    };
    const changed = () => { setLoaded(null); setFailed(false); load(); };
    load();
    window.addEventListener("hashchange", changed);
    return () => { disposed = true; generation++; window.removeEventListener("hashchange", changed); };
  }, [legacyToken]);
  if (failed) return <><h1>{t("acceptTitle")}</h1><FormError error="invitation_unavailable" /></>;
  if (loaded && !loaded.ok) return <><h1>{t("acceptTitle")}</h1><FormError error={loaded.error} /></>;
  if (!loaded) return <p role="status">{t("loadingInvitation")}</p>;
  const onboarding = loaded.onboarding;
  if (onboarding.status !== "valid") return <><h1>{t("acceptTitle")}</h1><FormError error={`invitation_${onboarding.status}`} /></>;
  if (loaded.wrongAccount) return <>
    <h1>{t("acceptTitle")}</h1><p>{t("wrongAccountIntro")}</p>
    <FormError error={signOutError} />
    <Button onClick={async () => { const result = await signOutInvitationAction(); if (result.ok) window.location.reload(); else setSignOutError(result.error); }}>{t("signOutToAccept")}</Button>
  </>;
  return <>
    <h1>{t(loaded.authenticated ? "acceptTitle" : onboarding.existingUser ? "logInToAcceptTitle" : "setPasswordTitle")}</h1>
    <p>{t(loaded.authenticated ? "signedInIntro" : onboarding.existingUser ? "existingUserIntro" : "newUserIntro")}</p>
    <AcceptInvitationForm token={token} email={onboarding.email} existingUser={onboarding.existingUser} alreadyAuthenticated={loaded.authenticated} />
  </>;
}
