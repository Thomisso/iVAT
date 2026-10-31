import type { ReactNode } from "react";
import { getTranslations } from "next-intl/server";
import { LanguageSwitcher } from "@/components/language-switcher";
import { ShellBrand } from "@/components/app-shell";
import { AuthDocumentArt } from "@/components/auth-document-art";

export async function FocusedShell({ actions, children }: { actions?: ReactNode; children: ReactNode }) {
  const [app, shell] = await Promise.all([
    getTranslations("app"),
    getTranslations("shell"),
  ]);
  return <div className="focused-shell">
    <a className="company-skip-link" href="#main-content">{shell("skip")}</a>
    <AuthDocumentArt />
    <header className="focused-shell-header">
      <div className="focused-shell-actions">
        <LanguageSwitcher />
        {actions}
      </div>
    </header>
    <div className="focused-shell-content"><div className="focused-shell-panel">
      <ShellBrand href="/" label={app("name")} />
      {children}
    </div></div>
  </div>;
}
