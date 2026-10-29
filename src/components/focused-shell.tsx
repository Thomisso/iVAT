import type { ReactNode } from "react";
import { getTranslations } from "next-intl/server";
import { LanguageSwitcher } from "@/components/language-switcher";
import { ShellBrand } from "@/components/app-shell";

export async function FocusedShell({ children }: { children: ReactNode }) {
  const [app, shell] = await Promise.all([
    getTranslations("app"),
    getTranslations("shell"),
  ]);
  return <div className="focused-shell">
    <a className="company-skip-link" href="#main-content">{shell("skip")}</a>
    <header className="focused-shell-header">
      <div className="focused-shell-identity">
        <ShellBrand href="/" label={app("name")} />
        <p>{app("tagline")}</p>
      </div>
      <LanguageSwitcher />
    </header>
    <div className="focused-shell-content">{children}</div>
  </div>;
}
