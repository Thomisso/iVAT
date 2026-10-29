"use client";

import type { ReactNode } from "react";
import { useTranslations } from "next-intl";
import { Icon, type IconName } from "./icon";

export type DocumentStatus =
  | "uploaded"
  | "waiting-for-allowance"
  | "waiting-for-platform"
  | "splitting"
  | "extracting"
  | "proposed"
  | "needs-review"
  | "duplicate"
  | "manual"
  | "failed"
  | "approved"
  | "locked"
  | "split"
  | "rejected";
export interface StatusBadgeProps {
  status: DocumentStatus;
  children?: ReactNode;
}

const states: Record<DocumentStatus, { tone: string; icon: IconName }> = {
  uploaded: { tone: "neutral", icon: "file" },
  "waiting-for-allowance": { tone: "warning", icon: "alert" },
  "waiting-for-platform": { tone: "warning", icon: "alert" },
  splitting: { tone: "ai", icon: "split" },
  extracting: { tone: "ai", icon: "marker" },
  proposed: { tone: "ai", icon: "marker" },
  "needs-review": { tone: "warning", icon: "alert" },
  duplicate: { tone: "warning", icon: "duplicate" },
  manual: { tone: "danger", icon: "alert" },
  failed: { tone: "danger", icon: "error" },
  approved: { tone: "success", icon: "check" },
  locked: { tone: "ink", icon: "lock" },
  split: { tone: "neutral", icon: "split" },
  rejected: { tone: "danger", icon: "error" },
};
export function StatusBadge({ status, children }: StatusBadgeProps) {
  const t = useTranslations("statusBadge");
  const state = states[status];
  return (
    <span className={`iv-badge iv-badge-${state.tone}`}>
      <Icon name={state.icon} />
      {children ?? t(status)}
    </span>
  );
}
