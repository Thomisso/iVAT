"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { useCurrentExportContext } from "./export-context";
import { FormError } from "@/components/form-error";

/** Retains the existing download link, posting only the current export details. */
export function PdfDownload({ href, fileName, children }: { href: string; fileName: string; children: ReactNode }) {
  const context = useCurrentExportContext();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const activeRequest = useRef<AbortController | null>(null);
  useEffect(() => () => activeRequest.current?.abort(), []);
  return <>
    <a className="iv-btn iv-btn-secondary iv-btn-md" href={href} download={fileName} aria-disabled={pending} onClick={async event => {
      if (!context) return;
      event.preventDefault();
      if (pending) return;
      const controller = new AbortController();
      activeRequest.current = controller;
      setPending(true);
      setError(null);
      try {
        const body = new FormData();
        Object.entries(context.details).forEach(([key, value]) => body.set(key, value));
        const response = await fetch(href, { method: "POST", body, signal: controller.signal });
        if (response.redirected) { window.location.assign(response.url); return; }
        if (!response.ok || !response.headers.get("Content-Type")?.startsWith("application/pdf")) {
          setError("export_failed");
          return;
        }
        const blob = await response.blob();
        controller.signal.throwIfAborted();
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = fileName;
        document.body.append(link);
        try { link.click(); } finally {
          link.remove();
          setTimeout(() => URL.revokeObjectURL(url), 1000);
        }
      } catch {
        if (!controller.signal.aborted) setError("export_failed");
      } finally {
        activeRequest.current = null;
        setPending(false);
      }
    }}>{children}</a>
    <FormError error={error} />
  </>;
}
