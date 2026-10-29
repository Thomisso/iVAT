import { getTranslations } from "next-intl/server";
import { FocusedShell } from "@/components/focused-shell";
import { EnrollmentForm } from "./enrollment-form";

export default async function MfaEnrollmentPage() {
  const t = await getTranslations("mfa");
  return (
    <FocusedShell>
      <main className="focused-shell-card" id="main-content" tabIndex={-1}>
        <h1>{t("enrollTitle")}</h1>
        <EnrollmentForm />
      </main>
    </FocusedShell>
  );
}
