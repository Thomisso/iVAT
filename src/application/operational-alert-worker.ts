import { createTranslator } from "next-intl";
import type { SystemClient } from "./client";
import type { Locale } from "@/i18n/locales";
import cs from "../../messages/cs.json";
import en from "../../messages/en.json";

export type AlertTransportOutcome = "accepted" | "refused" | "failed" | "unknown";
export type OperationalAlertMessage = { to: string; subject: string; text: string; html: string; messageId: string };
export type OperationalAlertMailer = { send(message: OperationalAlertMessage): Promise<AlertTransportOutcome> };
type Claim = {
  id: string; claimToken: string; episodeId: string; email: string; locale: Locale;
  kind: string; deliveryKind: "first" | "reminder" | "recovery"; detailHref: string;
  impact: { companies: number; documents: number; sourceFiles: number; exportJobs: number };
};
const labels = {
  allowance_exhausted: "problemAllowanceExhausted", waiting_documents: "problemWaitingDocuments",
  configuration_missing: "problemConfigurationMissing", configuration_unusable: "problemConfigurationUnusable",
  invalid_credentials: "problemInvalidCredentials", provider_credits_exhausted: "problemProviderCreditsExhausted",
  provider_unavailable: "problemProviderUnavailable", provider_response_invalid: "problemProviderResponseInvalid",
  processing_failed: "problemProcessingFailed", terminal_processing_job: "problemTerminalJob", failed_company_export: "problemFailedExport",
} as const;
const escapeHtml = (value: string) => value.replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);

/** One durable background observation and outbox drain. Never retries an uncertain claim. */
export async function runOperationalAlertTick(system: SystemClient, input: {
  mailer: OperationalAlertMailer; appOrigin: string; now?: string; clock?: () => string;
}) {
  const origin = new URL(input.appOrigin);
  if (!['https:', 'http:'].includes(origin.protocol) || origin.username || origin.password
    || origin.pathname !== "/" || origin.search || origin.hash
    || (origin.protocol === "http:" && !["localhost", "127.0.0.1", "::1", "[::1]"].includes(origin.hostname))) {
    throw new Error("Invalid canonical alert origin");
  }
  const clock = input.clock ?? (() => input.now ?? new Date().toISOString());
  const planned = await system.rpc("reconcile_operational_alerts", { observed_at: clock() });
  if (planned.error) throw planned.error;
  for (const id of planned.data as string[]) {
    const claimed = await system.rpc("claim_operational_alert", { target_delivery_id: id, observed_at: clock() });
    if (claimed.error) throw claimed.error;
    if (!claimed.data) continue;
    const claim = claimed.data as unknown as Claim;
    const messages = claim.locale === "en" ? en : cs;
    const t = createTranslator({ locale: claim.locale, messages, timeZone: "Europe/Prague" });
    const label = labels[claim.kind as keyof typeof labels];
    // The database supplies only allowlisted local remediation paths. Refuse any
    // malformed persisted receipt before exposing the current address to a transport.
    const link = new URL(claim.detailHref, origin);
    let outcome: AlertTransportOutcome = "failed";
    if (label && link.origin === origin.origin && ["/platform/ai-settings", "/platform/administration"].includes(link.pathname)) {
      const problem = t(`platformAdministration.${label}`);
      const heading = t(claim.deliveryKind === "recovery" ? "operationalAlerts.recoveryHeading"
        : claim.deliveryKind === "reminder" ? "operationalAlerts.reminderHeading" : "operationalAlerts.heading");
      const remediation = t(claim.deliveryKind === "recovery" ? "operationalAlerts.recoveryRemediation" : "operationalAlerts.remediation");
      const impact = claim.deliveryKind === "recovery" ? t("operationalAlerts.recoveryContext") : t("operationalAlerts.impact", claim.impact);
      const text = t("operationalAlerts.body", { heading, problem, impact, remediation, link: link.toString() });
      try {
        outcome = await input.mailer.send({ to: claim.email,
          subject: t(claim.deliveryKind === "recovery" ? "operationalAlerts.recoverySubject"
            : claim.deliveryKind === "reminder" ? "operationalAlerts.reminderSubject" : "operationalAlerts.subject"), text,
          html: `<h2>${escapeHtml(heading)}</h2><p>${escapeHtml(problem)}</p><p>${escapeHtml(impact).replace(/\n/g, "<br>")}</p><p><a href="${escapeHtml(link.toString())}">${escapeHtml(remediation)}</a></p>`,
          messageId: `<operational-alert-${claim.id}@${origin.hostname}>`,
        });
      } catch {
        // The process cannot prove whether SMTP accepted before an exception.
        outcome = "unknown";
      }
    }
    const finished = await system.rpc("finish_operational_alert", {
      target_delivery_id: id, target_claim_token: claim.claimToken, transport_outcome: outcome, observed_at: clock(),
    });
    if (finished.error) throw finished.error;
  }
}
