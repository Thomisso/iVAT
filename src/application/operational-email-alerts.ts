import type { AppClient, Result } from "./client";
import { isLocale, type Locale } from "@/i18n/locales";

export type OperationalAlertPreference = { enabled: boolean; locale: Locale };
type PreferenceError = "forbidden" | "invalid_alert_preference" | "verified_email_required";

export async function getOperationalAlertPreference(client: AppClient): Promise<Result<OperationalAlertPreference, "forbidden">> {
  const { data, error } = await client.rpc("operational_alert_preference");
  if (error?.code === "42501") return { ok: false, error: "forbidden" };
  if (error) throw error;
  return { ok: true, value: data as unknown as OperationalAlertPreference };
}

export async function setOperationalAlertPreference(client: AppClient, input: OperationalAlertPreference): Promise<Result<null, PreferenceError>> {
  if (typeof input.enabled !== "boolean" || !isLocale(input.locale)) return { ok: false, error: "invalid_alert_preference" };
  const { error } = await client.rpc("set_operational_alert_preference", { alert_enabled: input.enabled, alert_locale: input.locale });
  if (error?.code === "42501") return { ok: false, error: "forbidden" };
  if (error?.hint === "verified_email_required" || error?.hint === "invalid_alert_preference") return { ok: false, error: error.hint };
  if (error) throw error;
  return { ok: true, value: null };
}

export type OperationalAlertDelivery = {
  id: string; episodeId: string; rootKey: string; kind: string; state: "pending" | "sending" | "accepted" | "refused" | "failed" | "unknown" | "cancelled";
  eligibleSince: string; resolvedAt: string | null;
  impact: { companies: number; documents: number; sourceFiles: number; exportJobs: number };
};

/** The subscriber can inspect their own dispatch outcomes without personal payloads. */
export async function listOperationalAlertDeliveries(client: AppClient): Promise<Result<OperationalAlertDelivery[], "forbidden">> {
  const { data, error } = await client.rpc("operational_alert_deliveries");
  if (error?.code === "42501") return { ok: false, error: "forbidden" };
  if (error) throw error;
  return { ok: true, value: data as unknown as OperationalAlertDelivery[] };
}
