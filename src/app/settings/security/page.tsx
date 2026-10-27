import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { disenrollMfaAction } from "@/app/actions";
import { listOrganizationMfaSettings, mfaStatus } from "@/application/mfa";
import { Button } from "@/components/button";
import { requireUserClient } from "@/lib/supabase/server";
import { OrganizationMfaForm } from "./organization-mfa-form";

export default async function SecuritySettingsPage() {
  const client = await requireUserClient();
  const [status, organizations, t] = await Promise.all([
    mfaStatus(client),
    listOrganizationMfaSettings(client),
    getTranslations("mfa"),
  ]);
  return (
    <main className="panel">
      <h1>{t("securityTitle")}</h1>
      <section className="form">
        <h2>{t("authenticatorTitle")}</h2>
        <p>{status.enrolled ? t("authenticatorEnabled") : t("authenticatorDisabled")}</p>
        {status.enrolled ? (
          <form action={disenrollMfaAction}>
            <Button type="submit" variant="ghost">{t("disableAuthenticator")}</Button>
          </form>
        ) : <Link href="/mfa/enroll">{t("enableAuthenticator")}</Link>}
      </section>
      {organizations.map((organization) => (
        <section className="form" key={organization.id}>
          <h2>{organization.name}</h2>
          <p>{t("organizationEnforcementIntro")}</p>
          <OrganizationMfaForm organizationId={organization.id} required={organization.required} />
        </section>
      ))}
    </main>
  );
}
