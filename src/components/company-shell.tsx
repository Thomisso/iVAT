"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  startTransition,
  useEffect,
  type ReactNode,
} from "react";
import { useTranslations } from "next-intl";
import {
  markUploadNotificationReadAction,
  rememberCompanyAction,
  selectCompanyAction,
} from "@/app/actions";
import type { CompanySummary } from "@/application/companies";
import type { OrganizationSummary } from "@/application/organizations";
import type { UploadNotification } from "@/application/upload-batches";
import { AccountActions, AppShell, ContextNavigation } from "@/components/app-shell";
import { CommandButton } from "@/components/command-button";
import { AccountMenu, Menu, ShellIcon } from "@/components/shell-controls";

type Destination = "overview" | "upload" | "documents" | "vat" | "settings";

const destinations: Array<{ key: Destination; icon: string; suffix: string }> = [
  { key: "overview", icon: "M3 11 12 3l9 8v10h-6v-6H9v6H3z", suffix: "" },
  { key: "upload", icon: "M12 16V4m-5 5 5-5 5 5M4 15v6h16v-6", suffix: "/upload" },
  { key: "documents", icon: "M6 3h8l4 4v14H6V3Zm8 0v5h5M9 12h6M9 16h6", suffix: "/documents" },
  { key: "vat", icon: "M5 4h14v16H5V4Zm3 4h8M8 12h3m2 0h3m-8 4h3m2 0h3", suffix: "/vat" },
  { key: "settings", icon: "M9.5 3h5l.6 2.4 2 .8 2.1-1.2 2.5 4.3-1.8 1.6.2 2.2 1.8 1.6-2.5 4.3-2.1-1.2-2 .8-.6 2.4h-5l-.6-2.4-2-.8-2.1 1.2-2.5-4.3 1.8-1.6-.2-2.2-1.8-1.6L4.8 5l2.1 1.2 2-.8L9.5 3Zm2.5 6a3 3 0 1 0 0 6 3 3 0 0 0 0-6Z", suffix: "/settings" },
];

function activeDestination(pathname: string, companyId: string): Destination {
  const rest = pathname.slice(`/companies/${companyId}`.length);
  if (rest.startsWith("/documents")) return "documents";
  if (rest.startsWith("/source-files") || rest.startsWith("/upload-batches") || rest.startsWith("/upload")) return "upload";
  if (rest.startsWith("/vat") || rest.startsWith("/vat-reports")) return "vat";
  if (rest.startsWith("/settings") || rest.startsWith("/members") || rest.startsWith("/setup")) return "settings";
  return "overview";
}

function CompanyMenu({ companies, current }: { companies: CompanySummary[]; current: CompanySummary & { ico: string } }) {
  const t = useTranslations("shell");
  return <Menu label={t("companyMenu")} trigger={<><span className="company-initial">{current.name.slice(0, 1)}</span><span className="company-menu-copy"><strong>{current.name}</strong><small>{t("ico", { ico: current.ico })}</small></span><ShellIcon path="m9 6 6 6-6 6" /></>}>
    <p className="company-shell-menu-label">{t("companies")}</p>
    {companies.map((company) => <form action={selectCompanyAction} key={company.id}>
      <input name="companyId" type="hidden" value={company.id} />
      <button role="menuitem" type="submit">{company.name}{company.id === current.id ? <span>{t("current")}</span> : null}</button>
    </form>)}
    <Link href="/companies/new" role="menuitem">{t("addCompany")}</Link>
  </Menu>;
}

function AdministrationMenu({ companyId, companyRole, organizations, superAdmin }: { companyId: string; companyRole: "administrator" | "user" | null; organizations: OrganizationSummary[]; superAdmin: boolean }) {
  const t = useTranslations("shell");
  const organizationAdmins = organizations.filter((organization) => organization.role === "administrator");
  if (companyRole !== "administrator" && !organizationAdmins.length && !superAdmin) return null;
  return <Menu label={t("administrationMenu")} trigger={<><ShellIcon path="M9.5 3h5l.6 2.4 2 .8 2.1-1.2 2.5 4.3-1.8 1.6.2 2.2 1.8 1.6-2.5 4.3-2.1-1.2-2 .8-.6 2.4h-5l-.6-2.4-2-.8-2.1 1.2-2.5-4.3 1.8-1.6-.2-2.2-1.8-1.6L4.8 5l2.1 1.2 2-.8L9.5 3Zm2.5 6a3 3 0 1 0 0 6 3 3 0 0 0 0-6Z" /><span>{t("administration")}</span><ShellIcon path="m9 6 6 6-6 6" /></>}>
    {companyRole === "administrator" && <><p className="company-shell-menu-label">{t("companyAdministration")}</p><Link href={`/companies/${companyId}/members`} role="menuitem">{t("users")}</Link></>}
    {organizationAdmins.length > 0 && <p className="company-shell-menu-label">{t("organizationAdministration")}</p>}
    {organizationAdmins.map((organization) => <div className="company-shell-admin-group" key={organization.id}>
      <strong>{organization.name}</strong>
      <Link href={`/organizations/${organization.id}/members`} role="menuitem">{t("users")}</Link>
      <Link href={`/organizations/${organization.id}/ai-settings`} role="menuitem">{t("aiSettings")}</Link>
      <Link href={`/organizations/${organization.id}/ai-usage`} role="menuitem">{t("aiUsage")}</Link>
      <Link href={`/organizations/${organization.id}/audit-log`} role="menuitem">{t("auditLog")}</Link>
    </div>)}
    {superAdmin && <><p className="company-shell-menu-label">{t("platformAdministration")}</p><Link href="/platform/administration" role="menuitem">{t("platformOverview")}</Link><Link href="/platform/ai-settings" role="menuitem">{t("platformAi")}</Link><Link href="/platform/ai-usage" role="menuitem">{t("platformUsage")}</Link></>}
  </Menu>;
}

function UploadNotifications({ notifications }: { notifications: UploadNotification[] }) {
  const t = useTranslations("uploadWorkspace");
  if (!notifications.length) return null;
  return <section aria-label={t("notifications")} className="upload-notifications">
    {notifications.map((notification) => <aside className={`upload-notification upload-notification-${notification.outcome}`} key={notification.id} role="status">
      <div>
        <strong>{t(`notification.${notification.outcome}.title`)}</strong>
        <p>{t(`notification.${notification.outcome}.body`, {
          count: notification.fileCount,
          review: notification.reviewCount,
          failures: notification.failureCount,
        })}</p>
        <Link href={`/companies/${notification.companyId}/upload-batches/${notification.batchId}`}>{t("openBatch")}</Link>
      </div>
      <CommandButton action={markUploadNotificationReadAction} fields={{ notificationId: notification.id }} size="sm" variant="ghost">{t("markRead")}</CommandButton>
    </aside>)}
  </section>;
}

export function CompanyShell({ children, companies, company, companyRole, email, organizations, superAdmin, uploadNotifications }: {
  children: ReactNode;
  companies: CompanySummary[];
  company: CompanySummary & { ico: string };
  email: string;
  companyRole: "administrator" | "user" | null;
  organizations: OrganizationSummary[];
  superAdmin: boolean;
  uploadNotifications: UploadNotification[];
}) {
  const t = useTranslations("shell");
  const app = useTranslations("app");
  const pathname = usePathname();
  const active = activeDestination(pathname, company.id);
  useEffect(() => {
    startTransition(() => { void rememberCompanyAction(company.id); });
  }, [company.id]);

  const navigation = <ContextNavigation
    items={destinations.map((destination) => ({
      current: active === destination.key,
      href: `/companies/${company.id}${destination.suffix}`,
      icon: <ShellIcon path={destination.icon} />,
      label: t(destination.key),
    }))}
    label={t("companyNavigation")}
  />;
  const context = <CompanyMenu companies={companies} current={company} />;
  const accountActions = <AccountActions label={t("account")}>
    <AdministrationMenu
      companyId={company.id}
      companyRole={companyRole}
      organizations={organizations}
      superAdmin={superAdmin}
    />
    <AccountMenu email={email} />
  </AccountActions>;
  return <AppShell
    accountActions={accountActions}
    brandHref="/"
    brandLabel={app("name")}
    context={context}
    navigation={navigation}
    notices={<UploadNotifications notifications={uploadNotifications} />}
    skipLabel={t("skip")}
  >{children}</AppShell>;
}
