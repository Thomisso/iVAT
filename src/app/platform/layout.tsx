import { cookies } from "next/headers";
import { notFound } from "next/navigation";
import { currentUser } from "@/application/auth";
import { resolveCompanyContext } from "@/application/company-context";
import { isSuperAdmin } from "@/application/platform-ai";
import { PlatformShell } from "@/components/platform-shell";
import {
  companyContextCookie,
  parseCompanyContext,
} from "@/lib/company-context";
import { requireUserClient } from "@/lib/supabase/server";
import { currentPlatformOperationalProblems } from "./current-operational-problems";

export default async function PlatformLayout({
  children,
}: LayoutProps<"/platform">) {
  const client = await requireUserClient();
  const remembered = parseCompanyContext(
    (await cookies()).get(companyContextCookie)?.value,
  );
  const [auth, superAdmin, companyContext, operationalProblems] = await Promise.all([
    currentUser(client),
    isSuperAdmin(client),
    resolveCompanyContext(client, remembered),
    currentPlatformOperationalProblems(),
  ]);
  if (!auth || !superAdmin || !operationalProblems.ok) notFound();

  return (
    <PlatformShell
      companyHref={
        companyContext.kind === "company"
          ? `/companies/${companyContext.companyId}`
          : "/"
      }
      email={auth.email}
      operationalProblemCount={operationalProblems.value.length}
    >
      {children}
    </PlatformShell>
  );
}
