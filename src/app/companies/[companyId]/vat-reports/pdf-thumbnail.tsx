"use client";

import { useEffect, useRef, useState } from "react";
import type { PDFDocumentLoadingTask, RenderTask } from "pdfjs-dist";
import { useCurrentExportContext } from "./export-context";
import { FormError } from "@/components/form-error";

/** Render only the protected, separately prepared opening page. The complete
 * export is requested only by the surrounding download link. */
export function PdfThumbnail({ href, label }: { href: string; label: string }) {
  const context = useCurrentExportContext();
  const details = JSON.stringify(context?.details ?? {});
  const canvas = useRef<HTMLCanvasElement>(null);
  const [ready, setReady] = useState("");
  const [failed, setFailed] = useState("");
  const key = `${href}:${details}`;
  useEffect(() => {
    const controller = new AbortController();
    let loading: PDFDocumentLoadingTask | undefined;
    let rendering: RenderTask | undefined;
    const visible = canvas.current;
    if (visible) { visible.width = 1; visible.height = 1; }
    async function render() {
      try {
        const body = new FormData();
        Object.entries(JSON.parse(details) as Record<string, string>).forEach(([name, value]) => body.set(name, value));
        const response = await fetch(href, { method: "POST", body, signal: controller.signal });
        if (response.redirected) { window.location.assign(response.url); return; }
        if (!response.ok || !response.headers.get("Content-Type")?.startsWith("application/pdf")) throw new Error("Preview refused");
        const bytes = await response.arrayBuffer();
        const pdfjs = await import("pdfjs-dist");
        controller.signal.throwIfAborted();
        pdfjs.GlobalWorkerOptions.workerSrc = `/pdf-worker?v=${pdfjs.version}`;
        loading = pdfjs.getDocument({ data: bytes });
        const document = await loading.promise;
        controller.signal.throwIfAborted();
        const page = await document.getPage(1);
        const viewport = page.getViewport({ scale: 1.5 });
        const buffer = window.document.createElement("canvas");
        buffer.width = Math.ceil(viewport.width);
        buffer.height = Math.ceil(viewport.height);
        rendering = page.render({ canvas: buffer, viewport });
        await rendering.promise;
        controller.signal.throwIfAborted();
        if (visible) {
          visible.width = buffer.width;
          visible.height = buffer.height;
          visible.getContext("2d")?.drawImage(buffer, 0, 0);
          setReady(key);
        }
      } catch {
        if (!controller.signal.aborted) setFailed(key);
      } finally { if (loading) await loading.destroy(); }
    }
    void render();
    return () => {
      controller.abort();
      rendering?.cancel();
      void loading?.destroy();
    };
  }, [href, details, key]);
  return <>
    <canvas ref={canvas} className="vat-pdf-thumbnail" role="img" aria-label={label} aria-busy={ready !== key} data-ready={ready === key} />
    <FormError error={failed === key ? "export_failed" : null} />
  </>;
}
