"use client";

import Link from "next/link";
import { useTranslations } from "next-intl";
import type { ReactNode } from "react";
import {
  AccountActions,
  AppShell,
  ContextNavigation,
} from "@/components/app-shell";
import { AccountMenu, ShellIcon } from "@/components/shell-controls";
import { WorkSectionSwitch } from "@/components/work-section-switch";

export function PlatformShell({
  children,
  companyHref,
  email,
  operationalProblemCount,
}: {
  children: ReactNode;
  companyHref: string;
  email: string;
  operationalProblemCount: number;
}) {
  const t = useTranslations("shell");
  const app = useTranslations("app");
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
        <strong>{t("platform")}</strong>
        <small>{t("superAdmin")}</small>
      </span>
    </div>
  );
  const navigation = (
    <ContextNavigation
      items={[{
        current: true,
        href: "/platform/settings",
        icon: <ShellIcon path="M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8M12 3v2m0 14v2M3 12h2m14 0h2M5.6 5.6 7 7m10 10 1.4 1.4M5.6 18.4 7 17m10-10 1.4-1.4" />,
        label: t("settings"),
      }]}
      label={t("platformNavigation")}
    />
  );
  const accountActions = (
    <AccountActions label={t("accountActions")}>
      <Link
        aria-label={t("platformAlertBell", { count: operationalProblemCount })}
        className="notification-bell platform-alert-bell"
        href="/platform/administration#operational-problems-title"
      >
        <ShellIcon path="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4" />
        {operationalProblemCount > 0 && (
          <span aria-hidden="true" className="notification-bell-count">{operationalProblemCount}</span>
        )}
      </Link>
      <WorkSectionSwitch section="platform" companyHref={companyHref} />
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
