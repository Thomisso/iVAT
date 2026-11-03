import { getTranslations } from "next-intl/server";
import { PlatformPageLayout } from "../platform-page-layout";

export default async function PlatformSettingsPage() {
  const t = await getTranslations("shell");
  return <PlatformPageLayout title={t("platformSettingsTitle")} description={t("platformSettingsIntro")} />;
}
