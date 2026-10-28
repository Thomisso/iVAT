import { getTranslations } from "next-intl/server";
import { VerificationForm } from "./verification-form";

export default async function MfaVerificationPage() {
  const t = await getTranslations("mfa");
  return (
    <main className="panel">
      <h1>{t("verifyTitle")}</h1>
      <p>{t("verifyIntro")}</p>
      <VerificationForm />
    </main>
  );
}
