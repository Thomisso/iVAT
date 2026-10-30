import { getTranslations } from "next-intl/server";
import { logOutAction } from "@/app/actions";
import { listMyOrganizations } from "@/application/organizations";
import { Button } from "@/components/button";
import { FocusedShell } from "@/components/focused-shell";
import { requireUserClient } from "@/lib/supabase/server";
import { CompanyForm } from "./company-form";

export default async function NewCompanyPage() {
  const client = await requireUserClient();
  const [t, nav, organizations] = await Promise.all([
    getTranslations("company"),
    getTranslations("nav"),
    listMyOrganizations(client),
  ]);
  const administeredOrganizations = organizations.filter(
    (o) => o.role === "administrator",
  );
  return (
    <FocusedShell actions={
      <form action={logOutAction}>
        <Button type="submit" variant="ghost">{nav("logOut")}</Button>
      </form>
    }>
      <main
        className="company-create focused-shell-card focused-shell-card-wide"
        id="main-content"
        tabIndex={-1}
      >
        <h1>{t("createTitle")}</h1>
        {administeredOrganizations.length > 0 ? (
          <>
            <p>{t("createIntro")}</p>
            <CompanyForm
              organizationId={administeredOrganizations.length === 1 ? administeredOrganizations[0].id : ""}
              organizations={administeredOrganizations.length > 1 ? administeredOrganizations : undefined}
              initialValues={{
                personType: "legal",
              }}
            />
          </>
        ) : (
          <p>{t("noOrganization")}</p>
        )}
      </main>
    </FocusedShell>
  );
}
