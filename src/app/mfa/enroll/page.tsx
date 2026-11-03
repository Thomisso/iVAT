import Link from "next/link";
import { cookies } from "next/headers";
import { getTranslations } from "next-intl/server";
import { resolveSecurityReturnTo } from "@/application/security-return";
import { companyContextCookie, parseCompanyContext } from "@/lib/company-context";
import { requireUserClient } from "@/lib/supabase/server";
import { FocusedShell } from "@/components/focused-shell";
import { EnrollmentForm } from "./enrollment-form";

export default async function MfaEnrollmentPage({ searchParams }: PageProps<"/mfa/enroll">) {
  const t = await getTranslations("mfa");
  const requested = (await searchParams).returnTo;
  const returnTo = requested === undefined ? null : await resolveSecurityReturnTo(await requireUserClient(), requested,
    parseCompanyContext((await cookies()).get(companyContextCookie)?.value));
  const securityHref = returnTo === null ? null : `/settings/security?${new URLSearchParams({ returnTo })}`;
  return (
    <FocusedShell actions={securityHref && <Link href={securityHref}>{t("securityTitle")}</Link>}>
      <main className="focused-shell-card" id="main-content" tabIndex={-1}>
        <h1>{t("enrollTitle")}</h1>
        <EnrollmentForm completionHref={securityHref ?? "/"} />
      </main>
    </FocusedShell>
  );
}
