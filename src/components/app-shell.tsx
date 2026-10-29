import Link from "next/link";
import type { CSSProperties, ReactNode } from "react";

export type ContextNavigationItem = {
  accessibleLabel?: string;
  badge?: number;
  current?: boolean;
  href: string;
  icon?: ReactNode;
  label: string;
};

function BrandMark() {
  return <svg aria-hidden="true" className="company-brand-mark" viewBox="0 0 32 32">
    <path className="paper" d="M4 4h10v15l2 3 3-3V4h9v19l-7 6H11l-7-6z" />
    <path className="check" d="m9 14 7 7 8-11" />
  </svg>;
}

export function ShellBrand({ compact = false, href, label }: {
  compact?: boolean;
  href: string;
  label: string;
}) {
  return <Link aria-label={label} className="app-shell-brand company-brand" href={href}>
    <BrandMark />
    {!compact && <span>{label}</span>}
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
      aria-label={item.accessibleLabel}
      aria-current={item.current ? "page" : undefined}
      href={item.href}
      key={item.href}
    >
      {item.icon}
      <span>{item.label}</span>
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
        {accountActions}
      </aside>
      <header className="app-shell-mobile-header company-mobile-header">
        <ShellBrand compact href={brandHref} label={brandLabel} />
        {context}
        {accountActions}
      </header>
      {navigation}
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
