"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTranslations } from "next-intl";
import type { ReactNode } from "react";
import type { OrganizationSummary } from "@/application/organizations";
import { WorkSectionSwitch } from "@/components/work-section-switch";
import { AccountActions, AppShell, ContextNavigation } from "@/components/app-shell";
import { AccountMenu, Menu, ShellIcon } from "@/components/shell-controls";

type Destination = "users" | "auditLog";

const destinations: Array<{ key: Destination; icon: string; suffix: string }> = [
  { key: "users", icon: "M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2m7-10a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm13 10v-2a4 4 0 0 0-3-3.87m-3-10a4 4 0 0 1 0 7.75", suffix: "/users" },
  { key: "auditLog", icon: "M5 3h14v18H5zM9 7h6M9 11h6M9 15h4", suffix: "/audit-log" },
];

function activeDestination(pathname: string, organizationId: string): Destination {
  const rest = pathname.slice(`/organizations/${organizationId}`.length);
  if (rest.startsWith("/audit-log")) return "auditLog";
  return "users";
}

function OrganizationMenu({ current, organizations }: {
  current: OrganizationSummary;
  organizations: OrganizationSummary[];
}) {
  const t = useTranslations("shell");
  return <Menu label={t("organizationMenu")} trigger={<>
    <span className="company-initial" aria-hidden="true">{current.name.slice(0, 1)}</span>
    <span className="company-menu-copy">
      <small>{t("organizationContext")}</small>
      <strong>{current.name}</strong>
    </span>
    <ShellIcon path="m9 6 6 6-6 6" />
  </>}>
    <p className="company-shell-menu-label">{t("organizations")}</p>
    {organizations.map((organization) => <Link
      aria-current={organization.id === current.id ? "page" : undefined}
      href={`/organizations/${organization.id}/users`}
      key={organization.id}
      role="menuitem"
    >{organization.name}</Link>)}
  </Menu>;
}

export function OrganizationShell({ children, companyHref, email, organization, organizations, superAdmin }: {
  children: ReactNode;
  companyHref: string;
  email: string;
  organization: OrganizationSummary;
  organizations: OrganizationSummary[];
  superAdmin: boolean;
}) {
  const t = useTranslations("shell");
  const app = useTranslations("app");
  const pathname = usePathname();
  const active = activeDestination(pathname, organization.id);
  const context = <OrganizationMenu current={organization} organizations={organizations} />;
  const navigation = <ContextNavigation
    items={destinations.map((destination) => ({
      current: active === destination.key,
      href: `/organizations/${organization.id}${destination.suffix}`,
      icon: <ShellIcon path={destination.icon} />,
      label: t(destination.key),
    }))}
    label={t("organizationNavigation")}
  />;
  const accountActions = <AccountActions label={t("accountActions")}>
    <Link aria-label={t("returnToCompany")} className="organization-company-return" href={companyHref}>
      <ShellIcon path="m15 18-6-6 6-6" />
      <span>{t("companyWork")}</span>
    </Link>
    {superAdmin && <WorkSectionSwitch section="company" companyHref={companyHref} />}
    <AccountMenu email={email} />
  </AccountActions>;

  return <AppShell
    accountActions={accountActions}
    brandHref="/"
    brandLabel={app("name")}
    context={context}
    navigation={navigation}
    skipLabel={t("skip")}
  >{children}</AppShell>;
}
