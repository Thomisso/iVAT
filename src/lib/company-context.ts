export const companyContextCookie = "ivat_company_context";

export type StoredCompanyContext = { userId: string; companyId: string };

export function parseCompanyContext(value: string | undefined): StoredCompanyContext | null {
  if (!value) return null;
  const [userId, companyId, extra] = value.split(":");
  return userId && companyId && !extra ? { userId, companyId } : null;
}

export function serializeCompanyContext(context: StoredCompanyContext): string {
  return `${context.userId}:${context.companyId}`;
}
