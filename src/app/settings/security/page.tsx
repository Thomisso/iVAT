import { cookies } from "next/headers";
import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { listOrganizationMfaSettings, mfaStatus } from "@/application/mfa";
import { resolveSecurityReturnTo } from "@/application/security-return";
import { companyContextCookie, parseCompanyContext } from "@/lib/company-context";
import { FocusedShell } from "@/components/focused-shell";
import { availableAuthValue, requireUserClient } from "@/lib/supabase/server";
import { OrganizationMfaForm } from "./organization-mfa-form";
import { PasswordChangeForm } from "./password-change-form";
import { DisenrollMfaForm } from "./disenroll-mfa-form";

export default async function SecuritySettingsPage({ searchParams }: PageProps<"/settings/security">) {
  const client = await requireUserClient();
  const returnHref = await resolveSecurityReturnTo(client, (await searchParams).returnTo,
    parseCompanyContext((await cookies()).get(companyContextCookie)?.value));
  const enrollmentHref = `/mfa/enroll?${new URLSearchParams({ returnTo: returnHref })}`;
  const [status, organizations, t] = await Promise.all([
    mfaStatus(client).then(availableAuthValue),
    listOrganizationMfaSettings(client).then(availableAuthValue),
    getTranslations("mfa"),
  ]);
  return (
    <FocusedShell actions={<Link href={returnHref}>{t("returnToWork")}</Link>}>
      <main className="focused-shell-card focused-shell-card-wide" id="main-content" tabIndex={-1}>
        <h1>{t("securityTitle")}</h1>
        <PasswordChangeForm />
        <section className="form focused-shell-section">
          <h2>{t("authenticatorTitle")}</h2>
          <p>{status.enrolled ? t("authenticatorEnabled") : t("authenticatorDisabled")}</p>
          {status.enrolled ? (
            <><Link href={enrollmentHref}>{t("addAuthenticator")}</Link><DisenrollMfaForm /></>
          ) : <Link href={enrollmentHref}>{t("enableAuthenticator")}</Link>}
        </section>
        {organizations.map((organization) => (
          <section className="form focused-shell-section" id={`organization-${organization.id}`} key={organization.id}>
            <h2>{organization.name}</h2>
            <p>{t("organizationEnforcementIntro")}</p>
            <OrganizationMfaForm organizationId={organization.id} required={organization.required} />
          </section>
        ))}
      </main>
    </FocusedShell>
  );
}
