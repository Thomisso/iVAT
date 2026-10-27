import { getLocale, getTranslations } from "next-intl/server";
import { setLocaleAction } from "@/app/actions";
import { Button } from "./button";
import { locales } from "@/i18n/locales";

export async function LanguageSwitcher() {
  const t = await getTranslations("language");
  const current = await getLocale();
  return (
    <form
      action={setLocaleAction}
      className="language-switcher"
      aria-label={t("label")}
    >
      {locales.map((locale) => (
        <Button
          type="submit"
          size="sm"
          variant="ghost"
          key={locale}
          name="locale"
          value={locale}
          disabled={locale === current}
          lang={locale}
        >
          {t(locale)}
        </Button>
      ))}
    </form>
  );
}
