import { getTranslations } from "next-intl/server";
import { PlatformPageLayout } from "../../platform-page-layout";
import { OrganizationForm } from "./organization-form";

export default async function NewOrganizationPage() {
  const t = await getTranslations("organizationCreation");
  return <PlatformPageLayout title={t("title")} description={t("intro")}>
    <section className="panel"><OrganizationForm /></section>
  </PlatformPageLayout>;
}
