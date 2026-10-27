import { getTranslations } from "next-intl/server";
import { listMyOrganizations } from "@/application/organizations";
import { AppHeader } from "@/components/app-header";
import { requireUserClient } from "@/lib/supabase/server";
import { CompanyForm } from "./company-form";

export default async function NewCompanyPage() {
  const client = await requireUserClient();
  const t = await getTranslations("company");
  const organization = (await listMyOrganizations(client)).find((o) => o.role === "administrator");
  return (
    <>
      <AppHeader />
      <main className="card">
        <h1>{t("createTitle")}</h1>
        {organization ? (
          <>
            <p>{t("createIntro")}</p>
            <CompanyForm organizationId={organization.id} />
          </>
        ) : (
          <p>{t("noOrganization")}</p>
        )}
      </main>
    </>
  );
}
