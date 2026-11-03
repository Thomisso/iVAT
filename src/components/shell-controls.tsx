"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useTranslations } from "next-intl";
import { logOutAction, setLocaleAction } from "@/app/actions";
import { safeSecurityReturnTo } from "@/application/return-context";
import { ReleaseVersion } from "@/components/release-version";

export const settingsIconPath = "M9.5 3h5l.6 2.4 2 .8 2.1-1.2 2.5 4.3-1.8 1.6.2 2.2 1.8 1.6-2.5 4.3-2.1-1.2-2 .8-.6 2.4h-5l-.6-2.4-2-.8-2.1 1.2-2.5-4.3 1.8-1.6-.2-2.2-1.8-1.6L4.8 5l2.1 1.2 2-.8L9.5 3Zm2.5 6a3 3 0 1 0 0 6 3 3 0 0 0 0-6Z";

export function ShellIcon({ path }: { path: string }) {
  return <svg aria-hidden="true" className="company-shell-icon" viewBox="0 0 24 24"><path d={path} /></svg>;
}

export function Menu({ children, label, trigger, onOpen }: { children: ReactNode; label: string; trigger: ReactNode; onOpen?: () => void }) {
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
    <button aria-expanded={open} aria-haspopup="menu" className="company-shell-menu-trigger" onClick={() => {
      initialFocus.current = "first";
      if (!open) onOpen?.();
      setOpen((value) => !value);
    }} onKeyDown={(event) => {
      if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
      event.preventDefault();
      initialFocus.current = event.key === "ArrowDown" ? "first" : "last";
      onOpen?.();
      setOpen(true);
    }} ref={button} type="button"><span className="sr-only">{label}</span>{trigger}</button>
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

export function AccountMenu({ email }: { email: string }) {
  const t = useTranslations("shell");
  const language = useTranslations("language");
  const [securityHref, setSecurityHref] = useState("/settings/security");
  function captureOrigin() {
    const origin = safeSecurityReturnTo(`${window.location.pathname}${window.location.search}${window.location.hash}`);
    setSecurityHref(origin ? `/settings/security?${new URLSearchParams({ returnTo: origin })}` : "/settings/security");
  }
  return <Menu onOpen={captureOrigin} label={t("accountMenu")} trigger={<><span className="profile-avatar" aria-hidden="true">{email.slice(0, 1).toUpperCase()}</span><span className="profile-copy"><strong>{t("account")}</strong><small>{email}</small></span><ShellIcon path="m9 6 6 6-6 6" /></>}>
    <p className="company-shell-menu-label">{email}</p>
    <ReleaseVersion />
    <form action={setLocaleAction} aria-label={language("label")} className="company-shell-languages">
      <button lang="cs" name="locale" role="menuitem" type="submit" value="cs">{language("cs")}</button>
      <button lang="en" name="locale" role="menuitem" type="submit" value="en">{language("en")}</button>
    </form>
    <Link href={securityHref} role="menuitem">{t("security")}</Link>
    <form action={logOutAction}><button role="menuitem" type="submit">{t("logOut")}</button></form>
  </Menu>;
}
