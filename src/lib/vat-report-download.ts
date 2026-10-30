"use client";

import { startTransition } from "react";
import { acknowledgeVatReportDownloadAction } from "@/app/actions";
import type { DownloadAcknowledgementError } from "@/application/epo-export";
import type { Result } from "@/application/client";

const REFUSALS = new Set([
  "report_not_found", "invalid_export_format", "invalid_export_details", "epo_address_required",
  "stale_report", "report_finalized", "report_not_finalized", "xml_invalid", "forbidden",
]);

/** Shared creation/history path: receive every byte, initiate downloading, then acknowledge. */
export async function downloadVatReportXml(input: {
  url: string;
  companyId: string;
  period: string;
  format: string;
  kind: "draft" | "final";
  body?: FormData;
  signal?: AbortSignal;
  acknowledge?: boolean;
}): Promise<Result<null, string>> {
  const response = await fetch(input.url, {
    method: input.body ? "POST" : "GET", body: input.body, signal: input.signal,
  });
  if (response.redirected) {
    window.location.assign(response.url);
    return { ok: true, value: null };
  }
  if (!response.ok) {
    const failure = await response.json().catch(() => null);
    return { ok: false, error: REFUSALS.has(failure?.error) ? failure.error : "export_failed" };
  }
  if (!response.headers.get("Content-Type")?.startsWith("application/xml")) return { ok: false, error: "export_failed" };
  const blob = await response.blob();
  input.signal?.throwIfAborted();
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = response.headers.get("Content-Disposition")?.match(/filename="([^"]+)"/)?.[1]
    ?? `${input.kind === "draft" ? "DRAFT_" : ""}${input.format.toUpperCase()}_${input.period}.xml`;
  document.body.append(link);
  try { link.click(); } finally {
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  if (input.kind !== "draft" || input.acknowledge === false) return { ok: true, value: null };
  const artifactId = response.headers.get("X-iVAT-Artifact-ID");
  const reportGeneratedAt = response.headers.get("X-iVAT-Report-Generated-At");
  if (!artifactId || !reportGeneratedAt) return { ok: false, error: "download_acknowledgement_failed" };
  try {
    return await new Promise<Result<null, DownloadAcknowledgementError>>((resolve, reject) => {
      startTransition(() => {
        acknowledgeVatReportDownloadAction({
          companyId: input.companyId, period: input.period, format: input.format, artifactId, reportGeneratedAt,
        }).then(resolve, reject);
      });
    });
  } catch {
    return { ok: false, error: "download_acknowledgement_failed" };
  }
}
