"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTranslations } from "next-intl";

type SettingsDestination = { href: string; label: string };

export function SettingsNavigation({ companyId, administrator }: {
  companyId: string;
  administrator: boolean;
}) {
  const t = useTranslations("company");
  const pathname = usePathname();
  const base = `/companies/${companyId}/settings`;
  const destinations: SettingsDestination[] = [
    { href: base, label: t("settingsOverview") },
    ...(administrator ? [
      { href: `${base}/company`, label: t("companyDetails") },
      { href: `${base}/vat`, label: t("vatAndReporting") },
      { href: `${base}/users`, label: t("usersTitle") },
      { href: `${base}/data`, label: t("dataAndDeletion") },
    ] : []),
  ];
  const current = destinations.find((destination) => destination.href === pathname)?.href ?? base;

  return <nav aria-label={t("settingsNavigation")} className="company-settings-nav">
    {destinations.map((destination) => <Link
      aria-current={destination.href === current ? "true" : undefined}
      href={destination.href}
      key={destination.href}
    >{destination.label}</Link>)}
  </nav>;
}
