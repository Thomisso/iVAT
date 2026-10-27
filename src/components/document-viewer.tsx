import type { ReactNode } from "react";

export interface ViewerRegion {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  tag?: string;
  active?: boolean;
}
export interface DocumentViewerProps {
  regions?: ViewerRegion[];
  scanning?: boolean;
  toolbar?: ReactNode;
  label?: string;
  children?: ReactNode;
}
export function DocumentViewer({
  regions = [],
  scanning,
  toolbar,
  label,
  children,
}: DocumentViewerProps) {
  return (
    <section className="iv-viewer" aria-label={label}>
      {toolbar && <div className="iv-viewer-bar">{toolbar}</div>}
      <div className="iv-page">
        <div className="iv-page-content">{children}</div>
        {regions.map((region) => (
          <div
            key={region.id}
            className={`iv-region ${region.active ? "is-active" : ""}`}
            style={{
              left: `${region.x}%`,
              top: `${region.y}%`,
              width: `${region.w}%`,
              height: `${region.h}%`,
            }}
          >
            {region.active && region.tag && (
              <span className="iv-region-tag">{region.tag}</span>
            )}
          </div>
        ))}
        {scanning && <div className="iv-scan" aria-hidden="true" />}
      </div>
    </section>
  );
}
