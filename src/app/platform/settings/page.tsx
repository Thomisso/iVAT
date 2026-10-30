import { getTranslations } from "next-intl/server";
import { PageHeader, PageLayout } from "@/components/app-shell";

export default async function PlatformSettingsPage() {
  const t = await getTranslations("shell");
  return <PageLayout measure="wide">
    <PageHeader title={t("platformSettingsTitle")} description={t("platformSettingsIntro")} />
  </PageLayout>;
}
