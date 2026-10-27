import { getTranslations } from "next-intl/server";
import { EnrollmentForm } from "./enrollment-form";

export default async function MfaEnrollmentPage() {
  const t = await getTranslations("mfa");
  return (
    <main className="panel">
      <h1>{t("enrollTitle")}</h1>
      <EnrollmentForm />
    </main>
  );
}
