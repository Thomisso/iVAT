import { getTranslations } from "next-intl/server";
import { listMyOrganizations } from "@/application/organizations";
import { AppSidebar } from "@/components/app-sidebar";
import { requireUserClient } from "@/lib/supabase/server";
import { CompanyForm } from "./company-form";

export default async function NewCompanyPage() {
  const client = await requireUserClient();
  const t = await getTranslations("company");
  const organization = (await listMyOrganizations(client)).find(
    (o) => o.role === "administrator",
  );
  return (
    <>
      <AppSidebar />
      <main className="company-create">
        <div className="panel">
          <h1>{t("createTitle")}</h1>
          {organization ? (
            <>
              <p>{t("createIntro")}</p>
              <CompanyForm
                organizationId={organization.id}
                initialValues={{
                  personType: "legal",
                  filingFrequency: "monthly",
                  filingFrequencyEffectiveFrom: new Intl.DateTimeFormat(
                    "sv-SE",
                    { timeZone: "Europe/Prague" },
                  ).format(new Date()),
                }}
              />
            </>
          ) : (
            <p>{t("noOrganization")}</p>
          )}
        </div>
      </main>
    </>
  );
}
