"use client";

import { useTranslations } from "next-intl";
import { Notice } from "./notice";

export function FormError({ error }: { error: string | null }) {
  const t = useTranslations("errors");
  if (!error) return null;
  return <Notice tone="danger">{t.has(error) ? t(error) : error}</Notice>;
}
