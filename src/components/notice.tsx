import type { ReactNode } from "react";
import { Icon, type IconName } from "./icon";

export interface NoticeProps {
  tone?: "info" | "warning" | "danger" | "success";
  title?: string;
  children?: ReactNode;
}
const icons: Record<NonNullable<NoticeProps["tone"]>, IconName> = {
  info: "info",
  warning: "alert",
  danger: "error",
  success: "check",
};
export function Notice({ tone = "info", title, children }: NoticeProps) {
  return (
    <div
      className={`iv-notice iv-notice-${tone}`}
      role={tone === "danger" ? "alert" : "status"}
    >
      <Icon name={icons[tone]} />
      <div>
        {title && <strong>{title} </strong>}
        {children}
      </div>
    </div>
  );
}
