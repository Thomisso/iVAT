import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { setOrganizationPlatformAiAccessAction } from "@/app/actions";
import {
  listPlatformAiProviders,
  listPlatformOrganizations,
} from "@/application/platform-ai";
import { AppSidebar } from "@/components/app-sidebar";
import { CommandButton } from "@/components/command-button";
import { requireUserClient } from "@/lib/supabase/server";
import { PlatformAiProviderForm } from "./platform-ai-provider-form";

export default async function PlatformAiSettingsPage() {
  const client = await requireUserClient();
  const settings = await listPlatformAiProviders(client);
  if (!settings.ok) notFound();
  const t = await getTranslations("platformAi");
  const providers = await Promise.all(settings.value.map(async (provider) => ({
    provider,
    organizations: await listPlatformOrganizations(client, provider.provider),
  })));

  return (
    <>
      <AppSidebar />
      <main className="dashboard">
        <header>
          <h1>{t("title")}</h1>
          <p className="iv-muted">{t("intro")}</p>
        </header>
        {providers.map(({ provider, organizations }) => (
          <section key={provider.provider} className="panel platform-provider">
            <h2>{provider.provider}</h2>
            <PlatformAiProviderForm settings={provider} />
            <h3>{t("organizationAccess")}</h3>
            {organizations.ok && (
              <div className="platform-organizations">
                {organizations.value.map((organization) => (
                  <div key={organization.id} className="platform-organization">
                    <span>{organization.name}</span>
                    <CommandButton
                      action={setOrganizationPlatformAiAccessAction}
                      fields={{
                        organizationId: organization.id,
                        provider: provider.provider,
                        enabled: String(!organization.platformKeyEnabled),
                      }}
                      variant={organization.platformKeyEnabled ? "danger" : "secondary"}
                      size="sm"
                    >
                      {organization.platformKeyEnabled ? t("disableForOrganization") : t("enableForOrganization")}
                    </CommandButton>
                  </div>
                ))}
              </div>
            )}
          </section>
        ))}
      </main>
    </>
  );
}
