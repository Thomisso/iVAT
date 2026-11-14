"use server";

import { revalidatePath } from "next/cache";
import { getLocale } from "next-intl/server";
import { setOperationalAlertPreference } from "@/application/operational-email-alerts";
import { requireUserClient } from "@/lib/supabase/server";
import { isLocale } from "@/i18n/locales";
import type { FormState } from "@/app/actions";

export async function setOperationalAlertPreferenceAction(_previous: FormState, formData: FormData): Promise<FormState> {
  const enabled = formData.get("enabled") === "on";
  const locale = await getLocale();
  const result = await setOperationalAlertPreference(await requireUserClient(), { enabled, locale: isLocale(locale) ? locale : "cs" });
  if (result.ok) revalidatePath("/platform/settings");
  return { error: result.ok ? null : result.error, values: { enabled: enabled ? "on" : "off" } };
}
