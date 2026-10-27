import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { SignUpForm } from "./signup-form";

export default async function SignUpPage() {
  const t = await getTranslations("auth");
  return (
    <main className="panel">
      <h1>{t("signUpTitle")}</h1>
      <SignUpForm />
      <p>
        {t("haveAccount")} <Link href="/login">{t("logInLink")}</Link>
      </p>
    </main>
  );
}
