import { getTranslations } from "next-intl/server";
import { LanguageSwitcher } from "@/components/language-switcher";

export default async function AuthLayout({ children }: LayoutProps<"/">) {
  const t = await getTranslations("app");
  return (
    <>
      <header className="app-header">
        <span className="brand">{t("name")}</span>
        <span className="muted">{t("tagline")}</span>
        <LanguageSwitcher />
      </header>
      {children}
    </>
  );
}
