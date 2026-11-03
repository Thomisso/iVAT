import type { ReactNode } from "react";
import { SettingsPageLayout } from "@/components/app-shell";
import { PlatformSettingsNavigation } from "@/components/platform-settings-navigation";
import { currentPlatformOperationalProblems } from "./current-operational-problems";

export async function PlatformPageLayout({ children, description, title }: {
  children?: ReactNode;
  description?: ReactNode;
  title: ReactNode;
}) {
  const problems = await currentPlatformOperationalProblems();
  return <SettingsPageLayout title={title} description={description}
    navigation={<PlatformSettingsNavigation operationalProblemCount={problems.ok ? problems.value.length : 0} />}
  >{children}</SettingsPageLayout>;
}
