import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { FormError } from "@/components/form-error";
import { GoogleSignInButton } from "../google-sign-in-button";
import { LogInForm } from "./login-form";
import { ReleaseVersion } from "@/components/release-version";

export default async function LogInPage({ searchParams }: PageProps<"/login">) {
  const t = await getTranslations("auth");
  const error = (await searchParams).error;
  return (
    <main className="focused-shell-card" id="main-content" tabIndex={-1}>
      <h1>{t("logInTitle")}</h1>
      <FormError error={typeof error === "string" ? error : null} />
      <LogInForm />
      <GoogleSignInButton />
      <p>
        {t("noAccount")} <Link href="/signup">{t("signUpLink")}</Link>
      </p>
      <ReleaseVersion />
    </main>
  );
}
