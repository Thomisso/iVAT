import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { RecoveryRequestForm } from "./request-form";

export default async function PasswordRecoveryRequestPage() {
  const t = await getTranslations("passwordRecovery");
  return <main className="focused-shell-card" id="main-content" tabIndex={-1}>
    <h1>{t("requestTitle")}</h1><p>{t("requestIntro")}</p>
    <RecoveryRequestForm />
    <Link href="/login">{t("backToLogin")}</Link>
  </main>;
}
