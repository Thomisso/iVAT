import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { recoveryStatus } from "@/application/password-recovery";
import { mfaStatus } from "@/application/mfa";
import { createRequestClient } from "@/lib/supabase/server";
import { RecoveryLanding } from "./recovery-landing";
import { mfaReplacementStatus } from "@/application/mfa-replacement";
import { cookies } from "next/headers";
import { mfaContinuationCookie } from "@/lib/mfa-replacement";

export const metadata: Metadata = { referrer: "no-referrer", robots: { index: false, follow: false } };

export default async function PasswordRecoveryPage() {
  const t = await getTranslations("passwordRecovery");
  const client = await createRequestClient();
  const status = await recoveryStatus(client);
  const replacement = await mfaReplacementStatus(client);
  const mfa = status === "ready" || replacement.authorized ? await mfaStatus(client) : null;
  return <main className="focused-shell-card" id="main-content" tabIndex={-1}>
    <h1>{t("resetTitle")}</h1>
    <RecoveryLanding sessionStatus={status} needsAuthenticator={Boolean(mfa?.enrolled && (mfa.currentLevel !== "aal2" || replacement.hasHistory && !replacement.accessAllowed))}
      replacement={replacement} nativeAal2={mfa?.currentLevel === "aal2"} canResume={Boolean((await cookies()).get(mfaContinuationCookie)?.value)} />
  </main>;
}
