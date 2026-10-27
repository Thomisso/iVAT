"use client";

import { useTranslations } from "next-intl";

export function FormError({ error }: { error: string | null }) {
  const t = useTranslations("errors");
  if (!error) return null;
  return (
    <p role="alert" className="form-error">
      {t.has(error) ? t(error) : error}
    </p>
  );
}
