"use client";

import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import type { PDFDocumentLoadingTask, PDFDocumentProxy, RenderTask } from "pdfjs-dist";
import { Icon } from "@/components/icon";
import { useSourceEvidence, useSourceFieldLabel } from "./source-evidence-context";

export function PdfSourceViewer({ href, label, firstPage, lastPage }: {
  href: string; label: string; firstPage: number; lastPage: number;
}) {
  const t = useTranslations("review");
  const source = useSourceEvidence();
  const fieldLabel = useSourceFieldLabel();
  const evidence = source?.payload.sourceEvidence;
  const range = evidence && "firstPage" in evidence.range ? evidence.range : { firstPage, lastPage };
  const url = source?.versionId ? `${href}?version=${source.version}` : href;
  const [loadedPdf, setPdf] = useState<{ url: string; document: PDFDocumentProxy } | null>(null);
  const pdf = loadedPdf?.url === url ? loadedPdf.document : null;
  const [failed, setFailed] = useState("");
  const [navigation, setNavigation] = useState({ selection: source?.selection, page: range.firstPage });
  const [zoom, setZoom] = useState(1);
  const [width, setWidth] = useState(500);
  const [dimensions, setDimensions] = useState({ width: 500, height: 667, key: "" });
  const container = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const selected = source?.selectedField ? evidence?.fields[source.selectedField] : undefined;
  const [inspect, setInspect] = useState(false);
  const crop = useRef<HTMLCanvasElement>(null);
  const location = selected?.locations[source?.selectedLocation ?? 0];
  const selectedLocation = location?.kind === "page" ? location : undefined;
  const selectedPage = selectedLocation?.page;
  const page = navigation.selection !== source?.selection && selectedPage !== undefined ? selectedPage : navigation.page;
  const renderKey = `${url}:${page}:${width}:${zoom}`;
  const ready = dimensions.key === renderKey;
  useEffect(() => {
    const element = container.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.max(100, entry.contentRect.width)));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    let loading: PDFDocumentLoadingTask | undefined;
    void (async () => {
      try {
        const response = await fetch(url, { signal: controller.signal });
        if (!response.ok || !response.headers.get("Content-Type")?.startsWith("application/pdf")) throw new Error("PDF unavailable");
        const bytes = await response.arrayBuffer();
        const pdfjs = await import("pdfjs-dist");
        controller.signal.throwIfAborted();
        pdfjs.GlobalWorkerOptions.workerSrc = `/pdf-worker?v=${pdfjs.version}`;
        loading = pdfjs.getDocument({ data: bytes });
        const loaded = await loading.promise;
        controller.signal.throwIfAborted();
        setPdf({ url, document: loaded });
      } catch { if (!controller.signal.aborted) setFailed(url); }
    })();
    return () => { controller.abort(); void loading?.destroy(); };
  }, [url]);
  useEffect(() => {
    let cancelled = false;
    let rendering: RenderTask | undefined;
    void (async () => {
      if (!pdf) return;
      try {
        const documentPage = await pdf.getPage(page - range.firstPage + 1);
        if (cancelled) return;
        const basis = documentPage.getViewport({ scale: 1 });
        const viewport = documentPage.getViewport({ scale: width / basis.width * zoom });
        const ratio = window.devicePixelRatio || 1;
        const buffer = document.createElement("canvas");
        buffer.width = Math.ceil(viewport.width * ratio); buffer.height = Math.ceil(viewport.height * ratio);
        rendering = documentPage.render({ canvas: buffer, viewport, transform: [ratio, 0, 0, ratio, 0, 0] });
        await rendering.promise;
        if (cancelled || !canvas.current) return;
        canvas.current.width = buffer.width; canvas.current.height = buffer.height;
        canvas.current.getContext("2d")?.drawImage(buffer, 0, 0);
        setDimensions({ width: viewport.width, height: viewport.height, key: renderKey });
      } catch { if (!cancelled) setFailed(url); }
    })();
    return () => { cancelled = true; rendering?.cancel(); };
  }, [pdf, page, range.firstPage, width, zoom, renderKey, url]);
  const cropLocation = selectedLocation?.page === page ? selectedLocation : undefined;
  useEffect(() => {
    if (!inspect) return;
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !document.querySelector('dialog[open],[role="dialog"][aria-modal="true"]')) setInspect(false);
    };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [inspect]);
  useEffect(() => {
    const original = canvas.current; const visible = crop.current;
    if (!inspect || !ready || !cropLocation || !original || !visible) return;
    const sx = Math.max(0, cropLocation.x - 0.025) * original.width;
    const sy = Math.max(0, cropLocation.y - 0.025) * original.height;
    const sw = Math.min(original.width - sx, (cropLocation.width + 0.05) * original.width);
    const sh = Math.min(original.height - sy, (cropLocation.height + 0.05) * original.height);
    visible.width = 640; visible.height = Math.max(80, Math.round(640 * sh / sw));
    visible.getContext("2d")?.drawImage(original, sx, sy, sw, sh, 0, 0, visible.width, visible.height);
  }, [inspect, ready, cropLocation, renderKey]);
  return <section className="iv-viewer pdf-source-viewer" aria-label={label} data-evidence-version={source?.versionId}>
    <div className="pdf-source-toolbar">
      <label>{t("sourcePage")} <select aria-label={t("sourcePage")} value={page} onChange={(event) => setNavigation({ selection: source?.selection, page: Number(event.target.value) })}>
        {Array.from({ length: range.lastPage - range.firstPage + 1 }, (_, index) => range.firstPage + index).map((number) =>
          <option key={number} value={number}>{t("page", { page: number })}</option>)}
      </select></label>
      <label>{t("sourceZoom")} <select aria-label={t("sourceZoom")} value={zoom} onChange={(event) => setZoom(Number(event.target.value))}>
        {[0.75, 1, 1.25, 1.5, 2].map((scale) => <option key={scale} value={scale}>{t("sourceZoomValue", { percent: scale * 100 })}</option>)}
      </select></label>
      <button type="button" data-source-inspect-toggle aria-pressed={inspect} disabled={!inspect && (!selected || !ready)}
        onClick={() => setInspect((value) => !value)}><Icon name="search" />{t("sourceInspect")}</button>
    </div>
    {inspect && selected && cropLocation && ready && <aside className="pdf-source-inspect" data-source-inspect-crop aria-label={t("sourceInspectCrop")}>
      <canvas ref={crop} role="img" aria-label={t("sourceFor", { field: fieldLabel(source!.selectedField!) })} />
    </aside>}
    {failed === url && <p role="status">{t("sourceUnavailable")}</p>}
    {source?.selectedField && !selected && <p role="status">{t("sourceNoLocation")}</p>}
    <div className="pdf-source-scroll" ref={container}>
      <div className="pdf-source-page" data-original-page={page} style={{ width: dimensions.width, height: dimensions.height }} aria-busy={!ready}>
        <canvas ref={canvas} role="img" aria-label={t("sourceRenderedPage", { page })} data-ready={ready} style={{ width: dimensions.width, height: dimensions.height }} />
        {ready && Object.entries(evidence?.fields ?? {}).flatMap(([field, reference]) => reference.locations.flatMap((location, index) =>
          location.kind === "page" && location.page === page ? [<button type="button" key={`${field}-${index}`} data-source-region={field}
            className={`pdf-source-region ${source?.selectedField === field && source.selectedLocation === index ? "is-active" : ""}`}
            aria-label={t("sourceFor", { field: fieldLabel(field) })} aria-pressed={source?.selectedField === field && source.selectedLocation === index}
            onClick={() => source?.selectField(field, true, index)}
            style={{ left: `${location.x * 100}%`, top: `${location.y * 100}%`, width: `${location.width * 100}%`, height: `${location.height * 100}%` }} />] : []))}
      </div>
    </div>
  </section>;
}
