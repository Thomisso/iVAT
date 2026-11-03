"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  startTransition,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useTranslations } from "next-intl";
import {
  dismissCompanyUploadNotificationsAction,
  dismissUploadNotificationAction,
  markCompanyUploadNotificationsReadAction,
  markUploadNotificationReadAction,
  rememberCompanyAction,
  selectCompanyAction,
} from "@/app/actions";
import type { CompanySummary } from "@/application/companies";
import type { UploadNotification } from "@/application/upload-batches";
import { WorkSectionSwitch } from "@/components/work-section-switch";
import { AccountActions, AppShell, ContextNavigation } from "@/components/app-shell";
import { CommandButton } from "@/components/command-button";
import { AccountMenu, Menu, ShellIcon, settingsIconPath } from "@/components/shell-controls";

type Destination = "overview" | "upload" | "documents" | "vat" | "settings";

const destinations: Array<{ key: Destination; icon: string; suffix: string }> = [
  { key: "overview", icon: "M3 11 12 3l9 8v10h-6v-6H9v6H3z", suffix: "" },
  { key: "upload", icon: "M12 16V4m-5 5 5-5 5 5M4 15v6h16v-6", suffix: "/upload" },
  { key: "documents", icon: "M6 3h8l4 4v14H6V3Zm8 0v5h5M9 12h6M9 16h6", suffix: "/documents" },
  { key: "vat", icon: "M5 4h14v16H5V4Zm3 4h8M8 12h3m2 0h3m-8 4h3m2 0h3", suffix: "/vat" },
  { key: "settings", icon: settingsIconPath, suffix: "/settings" },
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

function NotificationBell({ companyId, notifications, unreadCount }: {
  companyId: string;
  notifications: UploadNotification[];
  unreadCount: number;
}) {
  const t = useTranslations("uploadWorkspace");
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLElement>(null);
  const titleId = useId();
  const panelId = useId();

  useEffect(() => {
    if (!open) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    panel.current?.querySelector<HTMLElement>("[data-notification-close]")?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setOpen(false);
        trigger.current?.focus();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = [...(panel.current?.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ) ?? [])];
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const close = () => {
    setOpen(false);
    trigger.current?.focus();
  };

  return <div className="notification-inbox">
    <button
      aria-controls={panelId}
      aria-expanded={open}
      aria-haspopup="dialog"
      aria-label={t("notificationBell", { count: unreadCount })}
      className="notification-bell"
      onClick={() => setOpen(true)}
      ref={trigger}
      type="button"
    >
      <ShellIcon path="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4" />
      {unreadCount > 0 && <span aria-hidden="true" className="notification-bell-count">{unreadCount}</span>}
    </button>
    {open && <div className="notification-panel-backdrop" onMouseDown={(event) => {
      if (event.target === event.currentTarget) close();
    }}>
      <section
        aria-labelledby={titleId}
        aria-modal="true"
        className="notification-panel"
        id={panelId}
        ref={panel}
        role="dialog"
      >
        <header className="notification-panel-header">
          <div>
            <h2 id={titleId}>{t("notifications")}</h2>
            <p>{t("notificationUnread", { count: unreadCount })}</p>
          </div>
          <button
            aria-label={t("closeNotifications")}
            className="notification-panel-close"
            data-notification-close
            onClick={close}
            type="button"
          ><ShellIcon path="M6 6l12 12M18 6 6 18" /></button>
        </header>
        {notifications.length > 0 ? <>
          <div className="notification-panel-bulk-actions">
            {unreadCount > 0 && <CommandButton
              action={markCompanyUploadNotificationsReadAction}
              fields={{ companyId }}
              size="sm"
              variant="ghost"
            >{t("markAllRead")}</CommandButton>}
            <CommandButton
              action={dismissCompanyUploadNotificationsAction}
              fields={{ companyId }}
              size="sm"
              variant="ghost"
            >{t("dismissAll")}</CommandButton>
          </div>
          <ul className="notification-list">
            {notifications.map((notification) => <li
              className={`notification-item notification-item-${notification.outcome}`}
              data-read={notification.readAt ? "true" : "false"}
              key={notification.id}
            >
              <div className="notification-item-copy">
                <strong>{t(`notification.${notification.outcome}.title`)}</strong>
                <p>{t(`notification.${notification.outcome}.body`, {
                  count: notification.fileCount,
                  review: notification.reviewCount,
                  failures: notification.failureCount,
                })}</p>
              </div>
              <div className="notification-item-actions">
                <Link onClick={() => setOpen(false)} href={`/companies/${notification.companyId}/upload-batches/${notification.batchId}`}>{t("openBatch")}</Link>
                {!notification.readAt && <CommandButton action={markUploadNotificationReadAction} fields={{ notificationId: notification.id }} size="sm" variant="ghost">{t("markRead")}</CommandButton>}
                <CommandButton action={dismissUploadNotificationAction} fields={{ notificationId: notification.id }} size="sm" variant="ghost">{t("dismiss")}</CommandButton>
              </div>
            </li>)}
          </ul>
        </> : <p className="notification-empty">{t("noNotifications")}</p>}
      </section>
    </div>}
  </div>;
}

export function CompanyShell({ children, companies, company, companyRole, email, superAdmin, uploadNotifications, uploadUnreadCount }: {
  children: ReactNode;
  companies: CompanySummary[];
  company: CompanySummary & { ico: string };
  email: string;
  companyRole: "administrator" | "user" | null;
  superAdmin: boolean;
  uploadNotifications: UploadNotification[];
  uploadUnreadCount: number;
}) {
  const t = useTranslations("shell");
  const app = useTranslations("app");
  const pathname = usePathname();
  const active = activeDestination(pathname, company.id);
  useEffect(() => {
    startTransition(() => { void rememberCompanyAction(company.id); });
  }, [company.id]);

  const navigation = <ContextNavigation
    items={destinations.filter((destination) => destination.key !== "settings" || companyRole === "administrator").map((destination) => ({
      current: active === destination.key,
      href: `/companies/${company.id}${destination.suffix}`,
      icon: <ShellIcon path={destination.icon} />,
      label: t(destination.key),
    }))}
    label={t("companyNavigation")}
  />;
  const context = <CompanyMenu companies={companies} current={company} />;
  const accountActions = <AccountActions label={t("account")}>
    <NotificationBell companyId={company.id} notifications={uploadNotifications} unreadCount={uploadUnreadCount} />
    {superAdmin && <WorkSectionSwitch section="company" companyHref={`/companies/${company.id}`} />}
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
