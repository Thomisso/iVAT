import Link from "next/link";
import Image from "next/image";
import type { CSSProperties, ReactNode } from "react";

export type ContextNavigationItem = {
  assistiveDescription?: string;
  badge?: number;
  current?: boolean;
  href: string;
  icon?: ReactNode;
  label: string;
};

export function ShellBrand({ compact = false, href, label }: {
  compact?: boolean;
  href: string;
  label: string;
}) {
  return <Link aria-label={label} className="app-shell-brand company-brand" href={href}>
    <Image alt="" aria-hidden="true" className={compact ? "company-brand-mark" : "brand-logo"}
      src={compact ? "/brand/mark.svg" : "/brand/logo.svg"} width={compact ? 28 : 103} height={compact ? 28 : 32} unoptimized />
  </Link>;
}

export function ContextNavigation({ items, label }: {
  items: ContextNavigationItem[];
  label: string;
}) {
  return <nav
    aria-label={label}
    className="app-shell-navigation company-primary-nav"
    style={{ "--app-shell-navigation-count": items.length } as CSSProperties}
  >
    {items.map((item) => <Link
      aria-current={item.current ? "page" : undefined}
      href={item.href}
      key={item.href}
    >
      {item.icon}
      <span>{item.label}</span>
      {item.assistiveDescription && <span className="sr-only"> {item.assistiveDescription}</span>}
      {item.badge !== undefined && item.badge > 0 && (
        <span aria-hidden="true" className="context-navigation-count">{item.badge}</span>
      )}
    </Link>)}
  </nav>;
}

export function AccountActions({ children, label }: { children?: ReactNode; label: string }) {
  return <div
    aria-label={label}
    className="app-shell-account-actions company-shell-secondary company-mobile-actions"
    role="group"
  >{children}</div>;
}

export function AppShell({
  accountActions,
  brandHref,
  brandLabel,
  children,
  context,
  navigation,
  notices,
  skipLabel,
}: {
  accountActions: ReactNode;
  brandHref: string;
  brandLabel: string;
  children?: ReactNode;
  context: ReactNode;
  navigation: ReactNode;
  notices?: ReactNode;
  skipLabel: string;
}) {
  return <>
    <a className="company-skip-link" href="#main-content">{skipLabel}</a>
    <div className="app-shell company-shell">
      <aside className="app-shell-sidebar company-shell-sidebar">
        <ShellBrand href={brandHref} label={brandLabel} />
        {context}
        <div className="app-shell-sidebar-navigation">
          {navigation}
        </div>
        {accountActions}
      </aside>
      <header className="app-shell-mobile-header company-mobile-header">
        <ShellBrand compact href={brandHref} label={brandLabel} />
        {context}
        {accountActions}
      </header>
      <div className="app-shell-content company-shell-content" id="main-content" tabIndex={-1}>
        {notices}
        {children}
      </div>
    </div>
  </>;
}

type PageMeasure = "narrow" | "wide";

export function PageLayout({ children, className, measure = "wide" }: {
  children?: ReactNode;
  className?: string;
  measure?: PageMeasure;
}) {
  return <main className={["app-page", `app-page-${measure}`, className].filter(Boolean).join(" ")}>
    {children}
  </main>;
}

export function PageHeader({ actions, children, description, title }: {
  actions?: ReactNode;
  children?: ReactNode;
  description?: ReactNode;
  title: ReactNode;
}) {
  return <header className="app-page-header">
    <div className="app-page-header-copy">
      <h1>{title}</h1>
      {description && <p>{description}</p>}
      {children}
    </div>
    {actions && <div className="app-page-actions">{actions}</div>}
  </header>;
}

export function PageContent({ children, measure = "wide" }: {
  children?: ReactNode;
  measure?: PageMeasure;
}) {
  return <div className={`app-page-content app-page-content-${measure}`}>{children}</div>;
}

/** The established Settings frame in both Company and Platform work. */
export function SettingsPageLayout({ children, description, navigation, title }: {
  children?: ReactNode;
  description?: ReactNode;
  navigation: ReactNode;
  title: ReactNode;
}) {
  return <PageLayout className="settings-page" measure="wide">
    <PageHeader title={title} description={description} />
    {navigation}
    <div className="settings-page-content">{children}</div>
  </PageLayout>;
}

export function SettingsSectionNavigation({ items, label }: {
  items: ContextNavigationItem[];
  label: string;
}) {
  return <nav aria-label={label} className="settings-section-nav">
    {items.map((item) => <Link
      aria-current={item.current ? "page" : undefined}
      href={item.href}
      key={item.href}
    >
      {item.label}
      {item.assistiveDescription && <span className="sr-only"> {item.assistiveDescription}</span>}
      {item.badge !== undefined && item.badge > 0 && <span aria-hidden="true" className="context-navigation-count">{item.badge}</span>}
    </Link>)}
  </nav>;
}
