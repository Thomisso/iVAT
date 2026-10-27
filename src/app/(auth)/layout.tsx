import { getTranslations } from "next-intl/server";
import { LanguageSwitcher } from "@/components/language-switcher";

export default async function AuthLayout({ children }: LayoutProps<"/">) {
  const t = await getTranslations("app");
  return (
    <>
      <header className="auth-header">
        <span className="iv-brand">{t("name")}</span>
        <span className="iv-muted">{t("tagline")}</span>
        <LanguageSwitcher />
      </header>
      <div className="auth-content">{children}</div>
    </>
  );
}
