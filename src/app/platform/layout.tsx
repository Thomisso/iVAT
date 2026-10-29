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

export default async function PlatformLayout({
  children,
}: LayoutProps<"/platform">) {
  const client = await requireUserClient();
  const remembered = parseCompanyContext(
    (await cookies()).get(companyContextCookie)?.value,
  );
  const [auth, superAdmin, companyContext] = await Promise.all([
    currentUser(client),
    isSuperAdmin(client),
    resolveCompanyContext(client, remembered),
  ]);
  if (!auth || !superAdmin) notFound();

  return (
    <PlatformShell
      companyHref={
        companyContext.kind === "company"
          ? `/companies/${companyContext.companyId}`
          : "/"
      }
      email={auth.email}
    >
      {children}
    </PlatformShell>
  );
}
