import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { listOrganizationMfaSettings, mfaStatus } from "@/application/mfa";
import { FocusedShell } from "@/components/focused-shell";
import { requireUserClient } from "@/lib/supabase/server";
import { OrganizationMfaForm } from "./organization-mfa-form";
import { PasswordChangeForm } from "./password-change-form";
import { DisenrollMfaForm } from "./disenroll-mfa-form";

export default async function SecuritySettingsPage() {
  const client = await requireUserClient();
  const [status, organizations, t] = await Promise.all([
    mfaStatus(client),
    listOrganizationMfaSettings(client),
    getTranslations("mfa"),
  ]);
  return (
    <FocusedShell>
      <main className="focused-shell-card focused-shell-card-wide" id="main-content" tabIndex={-1}>
        <h1>{t("securityTitle")}</h1>
        <PasswordChangeForm />
        <section className="form focused-shell-section">
          <h2>{t("authenticatorTitle")}</h2>
          <p>{status.enrolled ? t("authenticatorEnabled") : t("authenticatorDisabled")}</p>
          {status.enrolled ? (
            <><Link href="/mfa/enroll">{t("addAuthenticator")}</Link><DisenrollMfaForm /></>
          ) : <Link href="/mfa/enroll">{t("enableAuthenticator")}</Link>}
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
