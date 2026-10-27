import { getLocale, getTranslations } from "next-intl/server";
import { setLocaleAction } from "@/app/actions";
import { locales } from "@/i18n/locales";

export async function LanguageSwitcher() {
  const t = await getTranslations("language");
  const current = await getLocale();
  return (
    <form action={setLocaleAction} className="language-switcher" aria-label={t("label")}>
      {locales.map((locale) => (
        <button key={locale} name="locale" value={locale} disabled={locale === current} lang={locale}>
          {t(locale)}
        </button>
      ))}
    </form>
  );
}
