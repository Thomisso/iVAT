import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { listOrganizationAiProviderKeys } from "@/application/organization-ai";
import { listMyOrganizations } from "@/application/organizations";
import { AppSidebar } from "@/components/app-sidebar";
import { OrganizationAiProviderForm } from "@/components/organization-ai-provider-form";
import { requireUserClient } from "@/lib/supabase/server";

export default async function OrganizationAiSettingsPage({
  params,
}: PageProps<"/organizations/[organizationId]/ai-settings">) {
  const { organizationId } = await params;
  const client = await requireUserClient();
  const organization = (await listMyOrganizations(client)).find(
    (item) => item.id === organizationId && item.role === "administrator",
  );
  if (!organization) notFound();
  const settings = await listOrganizationAiProviderKeys(client, organizationId);
  if (!settings.ok) notFound();
  const t = await getTranslations("organizationAi");
  return (
    <>
      <AppSidebar />
      <main className="dashboard">
        <header>
          <h1>{t("title", { organization: organization.name })}</h1>
          <p className="iv-muted">{t("intro")}</p>
        </header>
        {settings.value.map((provider) => (
          <OrganizationAiProviderForm
            key={provider.provider}
            organizationId={organizationId}
            settings={provider}
          />
        ))}
      </main>
    </>
  );
}
