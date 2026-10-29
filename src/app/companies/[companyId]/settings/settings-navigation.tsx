"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useTranslations } from "next-intl";

type SettingsDestination = { href: string; label: string };

export function SettingsNavigation({ companyId, administrator }: {
  companyId: string;
  administrator: boolean;
}) {
  const t = useTranslations("company");
  const pathname = usePathname();
  const router = useRouter();
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

  return <>
    <nav aria-label={t("settingsNavigation")} className="company-settings-nav">
      {destinations.map((destination) => <Link
        aria-current={destination.href === current ? "page" : undefined}
        href={destination.href}
        key={destination.href}
      >{destination.label}</Link>)}
    </nav>
    <div className="company-settings-mobile-nav">
      <label htmlFor="company-settings-destination">{t("settingsNavigation")}</label>
      <select id="company-settings-destination" onChange={(event) => router.push(event.target.value)} value={current}>
        {destinations.map((destination) => <option key={destination.href} value={destination.href}>{destination.label}</option>)}
      </select>
    </div>
  </>;
}
