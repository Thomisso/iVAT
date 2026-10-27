import { getRequestConfig } from "next-intl/server";
import { cookies } from "next/headers";
import { defaultLocale, isLocale, localeCookie } from "./locales";

// The language is a per-browser preference stored in a cookie, not part of the URL.
export default getRequestConfig(async () => {
  const stored = (await cookies()).get(localeCookie)?.value;
  const locale = isLocale(stored) ? stored : defaultLocale;
  return { locale, messages: (await import(`../../messages/${locale}.json`)).default };
});
