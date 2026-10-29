import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { GoogleSignInButton } from "../google-sign-in-button";
import { SignUpForm } from "./signup-form";

export default async function SignUpPage() {
  const t = await getTranslations("auth");
  return (
    <main className="focused-shell-card" id="main-content" tabIndex={-1}>
      <h1>{t("signUpTitle")}</h1>
      <SignUpForm />
      <GoogleSignInButton />
      <p>
        {t("haveAccount")} <Link href="/login">{t("logInLink")}</Link>
      </p>
    </main>
  );
}
