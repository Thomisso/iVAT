"use client";

import { SettingsSectionNavigation } from "@/components/app-shell";
import { usePathname } from "next/navigation";
import { useTranslations } from "next-intl";

export function PlatformSettingsNavigation({ operationalProblemCount }: { operationalProblemCount: number }) {
  const t = useTranslations("shell");
  const pathname = usePathname();
  const destinations = [
    { href: "/platform/administration", label: "platformOverview" },
    { href: "/platform/ai-settings", label: "platformAi" },
    { href: "/platform/ai-usage", label: "platformUsage" },
  ] as const;
  return <SettingsSectionNavigation label={t("platformSettingsNavigation")}
    items={destinations.map((destination) => ({
      href: destination.href,
      label: t(destination.label),
      current: pathname === destination.href || (destination.label === "platformOverview" && pathname.startsWith("/platform/companies/")),
      ...(destination.label === "platformOverview" && operationalProblemCount > 0 ? {
        assistiveDescription: t("platformAlertsCount", { count: operationalProblemCount }),
        badge: operationalProblemCount,
      } : {}),
    }))}
  />;
}
