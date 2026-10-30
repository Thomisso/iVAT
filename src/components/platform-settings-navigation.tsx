"use client";

import Link from "next/link";
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
  return <nav aria-label={t("platformSettingsNavigation")} className="platform-settings-nav">
    {destinations.map((destination) => <Link
      aria-current={pathname === destination.href ? "page" : undefined}
      href={destination.href}
      key={destination.href}
    >
      {t(destination.label)}
      {destination.label === "platformOverview" && operationalProblemCount > 0 && <>
        <span className="sr-only"> {t("platformAlertsCount", { count: operationalProblemCount })}</span>
        <span aria-hidden="true" className="context-navigation-count">{operationalProblemCount}</span>
      </>}
    </Link>)}
  </nav>;
}
