import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { PlatformPageLayout } from "../platform-page-layout";
import { requireUserClient } from "@/lib/supabase/server";
import { getOperationalAlertPreference } from "@/application/operational-email-alerts";
import { OperationalAlertPreferenceForm } from "./operational-alert-preference-form";

export default async function PlatformSettingsPage() {
  const client = await requireUserClient();
  const preference = await getOperationalAlertPreference(client);
  if (!preference.ok) notFound();
  const [t, alerts] = await Promise.all([getTranslations("shell"), getTranslations("operationalAlerts")]);
  return <PlatformPageLayout title={t("platformSettingsTitle")} description={t("platformSettingsIntro")}>
    <section className="panel">
      <h2>{alerts("title")}</h2>
      <p>{alerts("intro")}</p>
      <OperationalAlertPreferenceForm enabled={preference.value.enabled} />
    </section>
  </PlatformPageLayout>;
}
