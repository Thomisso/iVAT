import { isUuid } from "./client";

const INTERNAL_ORIGIN = "https://ivat.invalid";
const UUID_PATH = "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}";
const DOCUMENT_PARAMS = ["view", "status", "direction", "reportingPeriod", "counterparty", "hasFindings", "batchId", "readiness", "page"];

export type CompanyReturnDestination = "company" | "documents" | "document" | "processing" | "vatReturn" | "controlStatement" | "exportHistory" | "periods" | "upload" | "batch" | "sourceFile";

export function companyReturnDestination(companyId: string, href: string): CompanyReturnDestination | null {
  const path = new URL(href, INTERNAL_ORIGIN).pathname;
  const prefix = `/companies/${companyId}`;
  if (path === prefix) return "company";
  if (!path.startsWith(`${prefix}/`)) return null;
  const suffix = path.slice(prefix.length);
  if (suffix === "/documents") return "documents";
  if (new RegExp(`^/documents/${UUID_PATH}$`).test(suffix)) return "document";
  if (suffix === "/upload") return "upload";
  if (new RegExp(`^/upload-batches/${UUID_PATH}$`).test(suffix)) return "batch";
  if (new RegExp(`^/source-files/${UUID_PATH}$`).test(suffix)) return "sourceFile";
  if (suffix === "/vat") return "periods";
  if (suffix === "/vat-reports") return "processing";
  const output = /^\/vat-reports\/20\d{2}-(?:0[1-9]|1[0-2]|Q[1-4])\/(vat-return|control-statement|exports)$/.exec(suffix)?.[1];
  return output === "vat-return" ? "vatReturn" : output === "control-statement" ? "controlStatement" : output === "exports" ? "exportHistory" : null;
}

/** Only known, same-Company work pages may be restored; this grants no data access. */
export function safeCompanyReturnTo(companyId: string, requested: unknown): string | null {
  return safeReturnTo(companyId, requested, 0);
}

function safeReturnTo(companyId: string, requested: unknown, depth: number): string | null {
  if (!isUuid(companyId) || typeof requested !== "string" || depth > 4
    || !requested.startsWith("/") || requested.startsWith("//") || /[\\\u0000-\u001f\u007f]/.test(requested)) return null;
  let url: URL;
  try { url = new URL(requested, INTERNAL_ORIGIN); } catch { return null; }
  if (url.origin !== INTERNAL_ORIGIN || /%2f|%5c/i.test(url.pathname)) return null;
  const destination = companyReturnDestination(companyId, url.pathname);
  if (!destination) return null;
  const allowed = destination === "documents" || destination === "document" ? [...DOCUMENT_PARAMS, "version"]
    : destination === "upload" ? ["createdFrom", "createdTo", "historyPage"]
      : destination === "processing" ? ["period"] : [];
  const query = new URLSearchParams();
  for (const key of allowed) {
    const value = url.searchParams.get(key);
    if (value === null) continue;
    if (["page", "historyPage", "version"].includes(key) && (!Number.isSafeInteger(Number(value)) || Number(value) < 1)) continue;
    query.set(key, value);
  }
  const parent = safeReturnTo(companyId, url.searchParams.get("returnTo"), depth + 1);
  if (parent) query.set("returnTo", parent);
  const hash = /^#(?:vat-step-(?:review|generate|outputs|export|finalize)|vat-output-issues|vat-line-\d+|control-entry-\d+|upload-history-title)$/.test(url.hash)
    || new RegExp(`^#(?:document|batch|source)-${UUID_PATH}$`).test(url.hash) ? url.hash : "";
  return `${url.pathname}${query.size ? `?${query}` : ""}${hash}`;
}

export function withCompanyReturnTo(companyId: string, href: string, origin: unknown): string {
  const destination = safeCompanyReturnTo(companyId, href) ?? `/companies/${companyId}/documents`;
  const parent = safeCompanyReturnTo(companyId, origin);
  if (!parent) return destination;
  const url = new URL(destination, INTERNAL_ORIGIN);
  url.searchParams.set("returnTo", parent);
  return `${url.pathname}?${url.searchParams}${url.hash}`;
}

/** Captures current filters and optional parent origin without trusting arbitrary route parameters. */
export function companyPageContext(companyId: string, path: string, search: Record<string, string | string[] | undefined>, hash = ""): string {
  const query = new URLSearchParams(Object.entries(search).flatMap(([key, value]) => typeof value === "string" ? [[key, value]] : []));
  return safeCompanyReturnTo(companyId, `${path}${query.size ? `?${query}` : ""}${hash}`) ?? `/companies/${companyId}/documents`;
}

/** Syntax-only Security origin allowlist. The server must revalidate access before displaying a return. */
export function safeSecurityReturnTo(requested: unknown): string | null {
  if (typeof requested !== "string" || requested.length > 16000 || !requested.startsWith("/") || requested.startsWith("//")
    || /[\\\u0000-\u001f\u007f]/.test(requested)) return null;
  let url: URL;
  try { url = new URL(requested, INTERNAL_ORIGIN); } catch { return null; }
  if (url.origin !== INTERNAL_ORIGIN || /%|\/\.{1,2}(?:\/|$)/.test(requested.split(/[?#]/)[0])) return null;
  const company = new RegExp(`^/companies/(${UUID_PATH})(?:/|$)`).exec(url.pathname);
  if (company) {
    const work = safeCompanyReturnTo(company[1], requested);
    if (work) return work;
  }
  let path = url.pathname;
  let allowed: string[];
  if (new RegExp(`^/companies/${UUID_PATH}/(?:settings(?:/(?:company|vat|users|data))?|setup(?:/(?:filing-frequency|ai-processing))?|members|documents/new)$`).test(path)) {
    path = path.replace(/\/members$/, "/settings/users");
    allowed = path.endsWith("/users") ? ["scope"] : path.endsWith("/settings/vat") ? ["generateYear"] : [];
  } else if (new RegExp(`^/organizations/${UUID_PATH}/(?:users|members|audit-log)$`).test(path)) {
    path = path.replace(/\/members$/, "/users");
    allowed = path.endsWith("/users") ? ["scope"] : ["companyId", "actorUserId", "action", "from", "to", "page"];
  } else if (new RegExp(`^/platform/companies/${UUID_PATH}/(?:history|members)$`).test(path)) {
    allowed = path.endsWith("/members") ? ["scope"] : [];
  } else if (["/platform", "/platform/settings", "/platform/administration", "/platform/ai-settings", "/platform/ai-usage"].includes(path)) {
    allowed = path === "/platform/ai-usage" ? ["from", "to", "organizationId", "companyId", "configurationId", "model", "operation", "groupBy"] : [];
  } else return null;
  const query = new URLSearchParams();
  for (const key of allowed) {
    const value = url.searchParams.get(key);
    if (value === null || url.searchParams.getAll(key).length !== 1) continue;
    if ((key === "scope" && value !== "organization" || key.endsWith("Id")) && !isUuid(value)) continue;
    if (key === "page" && (!Number.isSafeInteger(Number(value)) || Number(value) < 1)) continue;
    if (key === "generateYear" && !/^20\d{2}$/.test(value)) continue;
    query.set(key, value);
  }
  const hash = path === "/platform/administration" && /^#(?:operational-problems-title|failed-jobs)$/.test(url.hash)
    || path === "/platform/ai-settings" && new RegExp(`^#(?:configuration|company)-${UUID_PATH}$`).test(url.hash)
    || /\/settings(?:\/vat)?$/.test(path) && /^#(?:reporting-years|filing-defaults|settings-destinations-title|setup-checklist-title)$/.test(url.hash)
    ? url.hash : "";
  return `${path}${query.size ? `?${query}` : ""}${hash}`;
}
