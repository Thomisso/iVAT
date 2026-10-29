import { getTranslations } from "next-intl/server";
import { FocusedShell } from "@/components/focused-shell";
import { VerificationForm } from "./verification-form";

export default async function MfaVerificationPage() {
  const t = await getTranslations("mfa");
  return (
    <FocusedShell>
      <main className="focused-shell-card" id="main-content" tabIndex={-1}>
        <h1>{t("verifyTitle")}</h1>
        <p>{t("verifyIntro")}</p>
        <VerificationForm />
      </main>
    </FocusedShell>
  );
}
