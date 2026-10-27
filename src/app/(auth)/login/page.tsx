import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { LogInForm } from "./login-form";

export default async function LogInPage() {
  const t = await getTranslations("auth");
  return (
    <main className="panel">
      <h1>{t("logInTitle")}</h1>
      <LogInForm />
      <p>
        {t("noAccount")} <Link href="/signup">{t("signUpLink")}</Link>
      </p>
    </main>
  );
}
