"use client";

import Link from "next/link";
import { useState, type ReactNode } from "react";
import { useTranslations } from "next-intl";
import { Button } from "./button";
import { Icon, type IconName } from "./icon";

export type SidebarItem =
  | { group: string }
  | {
      label: string;
      icon: IconName;
      href?: string;
      count?: number;
      ai?: boolean;
      current?: boolean;
    };
export interface SidebarProps {
  company?: { name: string; ico: string };
  items: SidebarItem[];
  companySwitcher?: ReactNode;
  userMenu?: ReactNode;
}
export function Sidebar({
  company,
  items,
  companySwitcher,
  userMenu,
}: SidebarProps) {
  const t = useTranslations("nav");
  const [open, setOpen] = useState(false);
  return (
    <>
      <div className="mobile-nav">
        <Link href="/" className="iv-brand">
          iVAT
        </Link>
        <Button
          aria-expanded={open}
          aria-controls="app-sidebar"
          onClick={() => setOpen(!open)}
          icon="chevron"
        >
          {t("menu")}
        </Button>
      </div>
      <aside
        id="app-sidebar"
        className={`iv-side ${open ? "is-open" : ""}`}
        onClick={(event) => {
          if (event.target instanceof Element && event.target.closest("a"))
            setOpen(false);
        }}
      >
        <Link href="/" className="iv-brand">
          <b aria-hidden="true" />
          iVAT
        </Link>
        {companySwitcher ??
          (company && (
            <div className="iv-company">
              <Icon name="building" />
              <div className="iv-company-text">
                <span className="iv-company-name">{company.name}</span>
                <span className="iv-company-id">
                  {t("ico")} {company.ico}
                </span>
              </div>
            </div>
          ))}
        <nav
          className="iv-nav"
          aria-label={t("main")}
          onClick={() => setOpen(false)}
        >
          {items.map((item, index) =>
            "group" in item ? (
              <div className="iv-nav-group" key={index}>
                {item.group}
              </div>
            ) : (
              <Link
                key={index}
                href={item.href ?? "/"}
                className="iv-nav-item"
                aria-current={item.current ? "page" : undefined}
              >
                <Icon name={item.icon} />
                {item.label}
                {item.count !== undefined && (
                  <span className={`iv-nav-count ${item.ai ? "is-ai" : ""}`}>
                    {item.count}
                  </span>
                )}
              </Link>
            ),
          )}
        </nav>
        <div className="iv-user-menu">{userMenu}</div>
      </aside>
    </>
  );
}
