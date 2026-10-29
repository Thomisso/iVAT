"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTranslations } from "next-intl";
import type { ReactNode } from "react";
import {
  AccountActions,
  AppShell,
  ContextNavigation,
} from "@/components/app-shell";
import { AccountMenu, ShellIcon } from "@/components/shell-controls";

type Destination = "overview" | "aiSettings" | "aiUsage";
type DestinationLabel = "platformOverview" | "platformAi" | "platformUsage";

const destinations: Array<{
  key: Destination;
  label: DestinationLabel;
  href: string;
  icon: string;
}> = [
  {
    key: "overview",
    label: "platformOverview",
    href: "/platform/administration",
    icon: "M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z",
  },
  {
    key: "aiSettings",
    label: "platformAi",
    href: "/platform/ai-settings",
    icon: "M12 2a10 10 0 1 0 10 10M12 8v4l3 2",
  },
  {
    key: "aiUsage",
    label: "platformUsage",
    href: "/platform/ai-usage",
    icon: "M4 19V9m6 10V5m6 14v-7m4 7V3",
  },
];

function activeDestination(pathname: string): Destination {
  if (pathname.startsWith("/platform/ai-settings")) return "aiSettings";
  if (pathname.startsWith("/platform/ai-usage")) return "aiUsage";
  return "overview";
}

export function PlatformShell({
  children,
  companyHref,
  email,
}: {
  children: ReactNode;
  companyHref: string;
  email: string;
}) {
  const t = useTranslations("shell");
  const app = useTranslations("app");
  const active = activeDestination(usePathname());
  const context = (
    <div
      aria-label={t("platformContext")}
      className="platform-shell-context"
      role="group"
    >
      <span className="company-initial" aria-hidden="true">
        {t("platform").slice(0, 1)}
      </span>
      <span className="company-menu-copy">
        <small>{t("platform")}</small>
        <strong>{t("administration")}</strong>
      </span>
    </div>
  );
  const navigation = (
    <ContextNavigation
      items={destinations.map((destination) => ({
        current: destination.key === active,
        href: destination.href,
        icon: <ShellIcon path={destination.icon} />,
        label: t(destination.label),
      }))}
      label={t("platformNavigation")}
    />
  );
  const accountActions = (
    <AccountActions label={t("accountActions")}>
      <Link
        aria-label={t("returnToCompany")}
        className="organization-company-return"
        href={companyHref}
      >
        <ShellIcon path="m15 18-6-6 6-6" />
        <span>{t("companyWork")}</span>
      </Link>
      <AccountMenu email={email} />
    </AccountActions>
  );

  return (
    <AppShell
      accountActions={accountActions}
      brandHref="/"
      brandLabel={app("name")}
      context={context}
      navigation={navigation}
      skipLabel={t("skip")}
    >
      {children}
    </AppShell>
  );
}
