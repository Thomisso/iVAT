"use client";

import { useEffect, useRef, useState, type MouseEvent } from "react";
import { downloadVatReportXml } from "@/lib/vat-report-download";
import { FormError } from "./form-error";

export function VatReportArtifactDownload({ companyId, period, artifactId, fileName, format, kind, eligible, mediaType }: {
  companyId: string; period: string; artifactId: string; fileName: string; format: string;
  kind: "draft" | "final"; eligible: boolean; mediaType?: string;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), []);
  const href = `/companies/${companyId}/vat-reports/${period}/artifacts/${artifactId}`;
  async function download(event: MouseEvent<HTMLAnchorElement>) {
    if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey || event.button !== 0) return;
    event.preventDefault();
    if (request.current) return;
    const controller = new AbortController();
    request.current = controller;
    setPending(true);
    setError(null);
    try {
      const result = await downloadVatReportXml({ url: href, companyId, period, format, kind, acknowledge: eligible, signal: controller.signal });
      if (!result.ok) setError(result.error);
    } catch {
      if (!controller.signal.aborted) setError("export_failed");
    } finally {
      request.current = null;
      setPending(false);
    }
  }
  return <><a href={href} download={fileName} aria-disabled={pending || undefined} onClick={mediaType === "application/pdf" ? undefined : download}>{fileName}</a><FormError error={error} /></>;
}
