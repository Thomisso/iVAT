"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { Icon } from "@/components/icon";
import { useSourceEvidence, useSourceFieldLabel } from "./source-evidence-context";

/** The displayed original or persisted normalized JPEG is the same oriented AI basis. */
export function ImageSourceViewer({ href, label }: { href: string; label: string }) {
  const t = useTranslations("review");
  const source = useSourceEvidence();
  const fieldLabel = useSourceFieldLabel();
  const url = source?.versionId ? `${href}?version=${source.version}` : href;
  const [loaded, setLoaded] = useState({ url: "", width: 0, height: 0 });
  const [failed, setFailed] = useState("");
  const [zoom, setZoom] = useState(1);
  const [inspect, setInspect] = useState(false);
  const image = useRef<HTMLImageElement>(null);
  const crop = useRef<HTMLCanvasElement>(null);
  const captureImage = useCallback((node: HTMLImageElement | null) => {
    image.current = node;
    // A cached image can finish before hydration attaches onLoad.
    if (node?.complete && node.naturalWidth) setLoaded({ url, width: node.naturalWidth, height: node.naturalHeight });
  }, [url]);
  const ready = loaded.url === url;
  const evidence = source?.payload.sourceEvidence;
  const reference = source?.selectedField ? evidence?.fields[source.selectedField] : undefined;
  const location = reference?.locations[source?.selectedLocation ?? 0];
  const selected = location?.kind === "page" ? location : undefined;
  useEffect(() => {
    if (!inspect) return;
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !document.querySelector('dialog[open],[role="dialog"][aria-modal="true"]')) setInspect(false);
    };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [inspect]);
  useEffect(() => {
    const original = image.current; const visible = crop.current;
    if (!inspect || !ready || !selected || !original || !visible) return;
    const sx = Math.max(0, selected.x - 0.025) * loaded.width;
    const sy = Math.max(0, selected.y - 0.025) * loaded.height;
    const sw = Math.min(loaded.width - sx, (selected.width + 0.05) * loaded.width);
    const sh = Math.min(loaded.height - sy, (selected.height + 0.05) * loaded.height);
    const scale = Math.min(640 / sw, 480 / sh);
    visible.width = Math.max(1, Math.round(sw * scale)); visible.height = Math.max(1, Math.round(sh * scale));
    visible.getContext("2d")?.drawImage(original, sx, sy, sw, sh, 0, 0, visible.width, visible.height);
  }, [inspect, ready, selected, loaded]);
  return <section className="iv-viewer pdf-source-viewer image-source-viewer" aria-label={label} data-evidence-version={source?.versionId}>
    <div className="pdf-source-toolbar">
      <label>{t("sourceZoom")} <select aria-label={t("sourceZoom")} value={zoom} onChange={event => setZoom(Number(event.target.value))}>
        {[0.75, 1, 1.25, 1.5, 2].map(scale => <option key={scale} value={scale}>{t("sourceZoomValue", { percent: scale * 100 })}</option>)}
      </select></label>
      <button type="button" data-source-inspect-toggle aria-pressed={inspect} disabled={!inspect && (!selected || !ready)}
        onClick={() => setInspect(value => !value)}><Icon name="search" />{t("sourceInspect")}</button>
    </div>
    {inspect && selected && ready && <aside className="pdf-source-inspect" data-source-inspect-crop aria-label={t("sourceInspectCrop")}>
      <canvas ref={crop} role="img" aria-label={t("sourceFor", { field: fieldLabel(source!.selectedField!) })} />
    </aside>}
    {failed === url && <p role="status">{t("sourceUnavailable")}</p>}
    {source?.selectedField && !selected && <p role="status">{t("sourceNoLocation")}</p>}
    <div className="pdf-source-scroll">
      <div className="pdf-source-page image-source-page" style={{ width: `${zoom * 100}%` }} aria-busy={!ready}>
        {/* eslint-disable-next-line @next/next/no-img-element -- render the immutable AI basis without optimization */}
        <img ref={captureImage} src={url} alt={label} data-ready={ready} style={{ display: "block", width: "100%", height: "auto" }}
          onLoad={event => setLoaded({ url, width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })}
          onError={() => setFailed(url)} />
        {ready && Object.entries(evidence?.fields ?? {}).flatMap(([field, entry]) => entry.locations.flatMap((region, index) =>
          region.kind === "page" && region.page === 1 ? [<button type="button" key={`${field}-${index}`} data-source-region={field}
            className={`pdf-source-region ${source?.selectedField === field && source.selectedLocation === index ? "is-active" : ""}`}
            aria-label={t("sourceFor", { field: fieldLabel(field) })} aria-pressed={source?.selectedField === field && source.selectedLocation === index}
            onClick={() => source?.selectField(field, true, index)}
            style={{ left: `${region.x * 100}%`, top: `${region.y * 100}%`, width: `${region.width * 100}%`, height: `${region.height * 100}%` }} />] : []))}
      </div>
    </div>
  </section>;
}
