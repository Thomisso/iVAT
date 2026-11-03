import type { AppClient } from "./client";
import { getCompany, getMyCompanyRole } from "./companies";
import { resolveCompanyContext, type RememberedCompanyContext } from "./company-context";
import { getVatReport } from "./vat-reports";
import { getDocument } from "./documents";
import { getSourceFile } from "./source-files";
import { getUploadBatch } from "./upload-batches";
import { listAuditCompanies, listAuditActors } from "./audit";
import { listMyOrganizations } from "./organizations";
import { listAccessManagement } from "./memberships";
import { isSuperAdmin } from "./platform-ai";
import { getPlatformCompanyHistory } from "./platform-company-history";
import { safeSecurityReturnTo } from "./return-context";

async function authorizedOrigin(client: AppClient, href: string): Promise<boolean> {
  const url = new URL(href, "https://ivat.invalid");
  const parts = url.pathname.split("/");
  let organizationId: string | undefined;
  if (parts[1] === "companies") {
    const company = await getCompany(client, parts[2]);
    if (!company) return false;
    organizationId = company.organizationId;
    if (parts[3] === "documents" && parts[4] && parts[4] !== "new" && !await getDocument(client, company.id, parts[4])) return false;
    if (parts[3] === "source-files" && !await getSourceFile(client, company.id, parts[4])) return false;
    if (parts[3] === "upload-batches" && !await getUploadBatch(client, company.id, parts[4])) return false;
    if (["settings", "setup"].includes(parts[3]) && await getMyCompanyRole(client, company.id) !== "administrator") return false;
    if (parts[3] === "vat-reports" && parts[4] && !await getVatReport(client, company.id, parts[4])) return false;
  } else if (parts[1] === "organizations") {
    if (!(await listMyOrganizations(client)).some(item => item.id === parts[2] && item.role === "administrator")) return false;
    organizationId = parts[2];
    if (parts[3] === "audit-log") {
      const companyId = url.searchParams.get("companyId");
      const actorId = url.searchParams.get("actorUserId");
      if (companyId && !(await listAuditCompanies(client, organizationId)).some(item => item.id === companyId)) return false;
      if (actorId && !(await listAuditActors(client, organizationId)).some(item => item.userId === actorId)) return false;
    }
  } else if (parts[1] === "platform") {
    if (!await isSuperAdmin(client)) return false;
    if (parts[2] === "companies") {
      const history = await getPlatformCompanyHistory(client, parts[3]);
      if (!history.ok || parts[4] === "members" && history.value.deletedAt) return false;
      organizationId = history.value.snapshot.company.organizationId;
    }
  }
  const scope = url.searchParams.get("scope");
  if (scope && organizationId && !(await listAccessManagement(client, { organizationId, companyId: scope === "organization" ? null : scope })).ok) return false;
  return true;
}

/** Read-only return preference. Destination visibility and administrative scopes
 * are revalidated under the User's database identity. Refused or stale origins
 * use the same RLS-validated Company preference as direct entry; no access is granted. */
export async function resolveSecurityReturnTo(client: AppClient, requested: unknown, remembered: RememberedCompanyContext | null): Promise<string> {
  const href = safeSecurityReturnTo(requested);
  if (href && await authorizedOrigin(client, href)) return href;
  const context = await resolveCompanyContext(client, remembered);
  return context.kind === "company" ? `/companies/${context.companyId}` : "/";
}
