import type { ComponentType, ReactNode } from "react";
import { getTranslations } from "next-intl/server";
import { listAccessManagement } from "@/application/memberships";
import { requireUserClient } from "@/lib/supabase/server";
import { configuredInvitationUrls } from "@/lib/invitations";
import { MemberManagement } from "./member-management";
import { PageHeader } from "./app-shell";
import { Button } from "./button";
import { Notice } from "./notice";

/** All management entry points render this same scope selector and projection. */
export async function ScopedMemberManagement({ organizationId, initialCompanyId, requestedScope, headingLevel = 2, pageLayout: PageFrame }: {
  pageLayout?: ComponentType<{ children?: ReactNode; title: ReactNode }>;
  headingLevel?: 1 | 2;
  organizationId: string;
  initialCompanyId: string | null;
  requestedScope: string | string[] | undefined;
}) {
  const client = await requireUserClient();
  const t = await getTranslations("members");
  const renderPage = (children: ReactNode, title: ReactNode = t("managementScope")) =>
    PageFrame ? <PageFrame title={title}>{children}</PageFrame> : children;
  const companyId = requestedScope === undefined ? initialCompanyId : requestedScope === "organization" ? null : requestedScope;
  if (Array.isArray(companyId)) return renderPage(<Notice tone="warning">{t("scopeForbidden")}</Notice>);
  const result = await listAccessManagement(client, { organizationId, companyId });
  if (!result.ok) return renderPage(<Notice tone="warning">{t("scopeForbidden")}</Notice>);
  const { scope, scopes, users, pendingInvitations, blocked } = result.value;
  const urls = configuredInvitationUrls();
  const title = t(scope.companyId === null ? "organizationTitle" : "companyTitle", {
    organization: scope.name, company: scope.name,
  });
  const content = <section className={headingLevel === 1 ? "scoped-member-management" : "company-settings-section company-settings-users"}>
    {!PageFrame && (headingLevel === 1 ? <PageHeader title={title} /> : <header><h2>{title}</h2></header>)}
    {blocked && <Notice tone="warning">{(await getTranslations("platformHistory"))("blockedNotice")}</Notice>}
    <form method="get" className="form-row form-row-action member-scope-filter">
      <div className="iv-field-label">
        <label htmlFor="member-management-scope">{t("managementScope")}</label>
        <select id="member-management-scope" name="scope" defaultValue={scope.companyId ?? "organization"}>
          {scopes.map(item => <option key={item.companyId ?? "organization"} value={item.companyId ?? "organization"}>
            {t(item.companyId === null ? "organizationScope" : "companyScope", { name: item.name })}
          </option>)}
        </select>
      </div>
      <Button type="submit">{t("applyScope")}</Button>
    </form>
    <MemberManagement key={`${organizationId}:${scope.companyId ?? "organization"}`}
      acceptUrl={urls.ok ? urls.value.acceptUrl : null} organizationId={organizationId} companyId={scope.companyId}
      users={users} pendingInvitations={pendingInvitations} />
  </section>;
  return renderPage(content, title);
}
