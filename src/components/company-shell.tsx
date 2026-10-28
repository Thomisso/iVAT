"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  startTransition,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useTranslations } from "next-intl";
import {
  logOutAction,
  rememberCompanyAction,
  selectCompanyAction,
  setLocaleAction,
} from "@/app/actions";
import type { CompanySummary } from "@/application/companies";
import type { OrganizationSummary } from "@/application/organizations";

type Destination = "overview" | "upload" | "documents" | "vat" | "settings";

const destinations: Array<{ key: Destination; icon: string; suffix: string }> = [
  { key: "overview", icon: "M3 11 12 3l9 8v10h-6v-6H9v6H3z", suffix: "" },
  { key: "upload", icon: "M12 16V4m-5 5 5-5 5 5M4 15v6h16v-6", suffix: "/upload" },
  { key: "documents", icon: "M6 3h8l4 4v14H6V3Zm8 0v5h5M9 12h6M9 16h6", suffix: "/documents" },
  { key: "vat", icon: "M5 4h14v16H5V4Zm3 4h8M8 12h3m2 0h3m-8 4h3m2 0h3", suffix: "/vat" },
  { key: "settings", icon: "M9.5 3h5l.6 2.4 2 .8 2.1-1.2 2.5 4.3-1.8 1.6.2 2.2 1.8 1.6-2.5 4.3-2.1-1.2-2 .8-.6 2.4h-5l-.6-2.4-2-.8-2.1 1.2-2.5-4.3 1.8-1.6-.2-2.2-1.8-1.6L4.8 5l2.1 1.2 2-.8L9.5 3Zm2.5 6a3 3 0 1 0 0 6 3 3 0 0 0 0-6Z", suffix: "/settings" },
];

function ShellIcon({ path }: { path: string }) {
  return <svg aria-hidden="true" className="company-shell-icon" viewBox="0 0 24 24"><path d={path} /></svg>;
}

function BrandMark() {
  return <svg aria-hidden="true" className="company-brand-mark" viewBox="0 0 32 32"><path className="paper" d="M4 4h10v15l2 3 3-3V4h9v19l-7 6H11l-7-6z" /><path className="check" d="m9 14 7 7 8-11" /></svg>;
}

function activeDestination(pathname: string, companyId: string): Destination {
  const rest = pathname.slice(`/companies/${companyId}`.length);
  if (rest.startsWith("/documents")) return "documents";
  if (rest.startsWith("/source-files") || rest.startsWith("/upload-batches") || rest.startsWith("/upload")) return "upload";
  if (rest.startsWith("/vat") || rest.startsWith("/vat-reports")) return "vat";
  if (rest.startsWith("/settings") || rest.startsWith("/members")) return "settings";
  return "overview";
}

function Menu({ children, label, trigger }: { children: ReactNode; label: string; trigger: ReactNode }) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const initialFocus = useRef<"first" | "last">("first");

  useEffect(() => {
    if (!open) return;
    const items = menu.current?.querySelectorAll<HTMLElement>("[role=menuitem]");
    items?.[initialFocus.current === "first" ? 0 : items.length - 1]?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setOpen(false);
      button.current?.focus();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open]);

  return <div className="company-shell-menu">
    <button aria-expanded={open} aria-haspopup="menu" aria-label={label} className="company-shell-menu-trigger" onClick={() => {
      initialFocus.current = "first";
      setOpen((value) => !value);
    }} onKeyDown={(event) => {
      if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
      event.preventDefault();
      initialFocus.current = event.key === "ArrowDown" ? "first" : "last";
      setOpen(true);
    }} ref={button} type="button">{trigger}</button>
    {open && <div aria-label={label} className="company-shell-popover" onClick={(event) => {
      if (event.target instanceof Element && event.target.closest("a")) setOpen(false);
    }} onKeyDown={(event) => {
      const items = [...(menu.current?.querySelectorAll<HTMLElement>("[role=menuitem]") ?? [])];
      const index = Math.max(0, items.indexOf(document.activeElement as HTMLElement));
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const step = event.key === "ArrowDown" ? 1 : -1;
        items[(index + step + items.length) % items.length]?.focus();
      } else if (event.key === "Home" || event.key === "End") {
        event.preventDefault();
        items[event.key === "Home" ? 0 : items.length - 1]?.focus();
      } else if (event.key === "Tab") {
        setOpen(false);
      }
    }} ref={menu} role="menu">{children}</div>}
  </div>;
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

function AccountMenu({ email }: { email: string }) {
  const t = useTranslations("shell");
  const language = useTranslations("language");
  return <Menu label={t("accountMenu")} trigger={<><span className="profile-avatar" aria-hidden="true">{email.slice(0, 1).toUpperCase()}</span><span className="profile-copy"><strong>{t("account")}</strong><small>{email}</small></span><ShellIcon path="m9 6 6 6-6 6" /></>}>
    <p className="company-shell-menu-label">{email}</p>
    <form action={setLocaleAction} aria-label={language("label")} className="company-shell-languages">
      <button lang="cs" name="locale" role="menuitem" type="submit" value="cs">{language("cs")}</button>
      <button lang="en" name="locale" role="menuitem" type="submit" value="en">{language("en")}</button>
    </form>
    <Link href="/settings/security" role="menuitem">{t("security")}</Link>
    <form action={logOutAction}><button role="menuitem" type="submit">{t("logOut")}</button></form>
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

export function CompanyShell({ children, companies, company, companyRole, email, organizations, superAdmin }: {
  children: ReactNode;
  companies: CompanySummary[];
  company: CompanySummary & { ico: string };
  email: string;
  companyRole: "administrator" | "user" | null;
  organizations: OrganizationSummary[];
  superAdmin: boolean;
}) {
  const t = useTranslations("shell");
  const app = useTranslations("app");
  const pathname = usePathname();
  const active = activeDestination(pathname, company.id);
  useEffect(() => {
    startTransition(() => { void rememberCompanyAction(company.id); });
  }, [company.id]);

  const navigation = <nav aria-label={t("companyNavigation")} className="company-primary-nav">{destinations.map((destination) => <Link aria-current={active === destination.key ? "page" : undefined} href={`/companies/${company.id}${destination.suffix}`} key={destination.key}><ShellIcon path={destination.icon} /><span>{t(destination.key)}</span></Link>)}</nav>;
  return <>
    <a className="company-skip-link" href="#main-content">{t("skip")}</a>
    <div className="company-shell">
      <aside className="company-shell-sidebar">
        <Link aria-label={app("name")} className="company-brand" href="/"><BrandMark /><span>{app("name")}</span></Link>
        <CompanyMenu companies={companies} current={company} />
        <div className="company-shell-secondary"><AdministrationMenu companyId={company.id} companyRole={companyRole} organizations={organizations} superAdmin={superAdmin} /><AccountMenu email={email} /></div>
      </aside>
      <header className="company-mobile-header"><Link aria-label={app("name")} className="company-brand" href="/"><BrandMark /></Link><CompanyMenu companies={companies} current={company} /><div className="company-mobile-actions"><AdministrationMenu companyId={company.id} companyRole={companyRole} organizations={organizations} superAdmin={superAdmin} /><AccountMenu email={email} /></div></header>
      {navigation}
      <div className="company-shell-content" id="main-content" tabIndex={-1}>{children}</div>
    </div>
  </>;
}
