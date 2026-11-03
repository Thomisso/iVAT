import type { Metadata } from "next";
import Link from "next/link";
import { getTranslations } from "next-intl/server";

export const metadata: Metadata = { robots: { index: false, follow: false } };

/** No session or policy queries: a refusal must stay readable during an outage.
 * Retrying enters the normal authenticated routes and native MFA gates again. */
export default async function AuthenticationUnavailablePage() {
  const [t, errors] = await Promise.all([getTranslations("availability"), getTranslations("errors")]);
  return <main className="focused-shell-card" id="main-content" tabIndex={-1}>
    <h1>{t("title")}</h1>
    <p role="alert">{errors("auth_unavailable")}</p>
    <Link href="/">{t("retry")}</Link>
  </main>;
}
