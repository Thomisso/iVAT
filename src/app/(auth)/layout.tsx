import { FocusedShell } from "@/components/focused-shell";

export default function AuthLayout({ children }: LayoutProps<"/">) {
  return <FocusedShell>{children}</FocusedShell>;
}
