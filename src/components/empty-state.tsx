import type { ReactNode } from "react";
import { Icon, type IconName } from "./icon";

export interface EmptyStateProps {
  title: string;
  icon?: IconName;
  action?: ReactNode;
  children?: ReactNode;
}
export function EmptyState({ title, icon, action, children }: EmptyStateProps) {
  return (
    <div className="iv-empty">
      {icon && <Icon name={icon} size={24} />}
      <p className="iv-empty-title">{title}</p>
      {children && <p>{children}</p>}
      {action}
    </div>
  );
}
