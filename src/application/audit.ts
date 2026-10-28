import type { Json } from "@/lib/database.types";
import { isUuid, type AppClient } from "./client";

export type AuditEvent = {
  id: number;
  occurredAt: string;
  actorUserId: string | null;
  organizationId: string;
  companyId: string | null;
  action: string;
  targetType: string;
  targetId: string | null;
  payload: Json;
};

export type AuditEventPage = {
  events: AuditEvent[];
  page: number;
  pageSize: number;
  total: number;
  pageCount: number;
};

export type AuditEventFilters = {
  companyId?: string;
  actorUserId?: string;
  action?: string;
  from?: string;
  to?: string;
};

export type AuditEventPageInput = AuditEventFilters & { page?: number; pageSize?: number };

export type AuditActor = { userId: string; email: string };

function auditDate(value: string | undefined): Date | null {
  if (!value || !/^20\d{2}-\d{2}-\d{2}$/.test(value)) return null;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value ? parsed : null;
}

function auditEvent(row: {
  id: number;
  occurred_at: string;
  actor_user_id: string | null;
  organization_id: string;
  company_id: string | null;
  action: string;
  target_type: string;
  target_id: string | null;
  payload: Json;
}): AuditEvent {
  return {
    id: row.id,
    occurredAt: row.occurred_at,
    actorUserId: row.actor_user_id,
    organizationId: row.organization_id,
    companyId: row.company_id,
    action: row.action,
    targetType: row.target_type,
    targetId: row.target_id,
    payload: row.payload,
  };
}

/** Current Organization members that can be selected as audit actors. */
export async function listAuditActors(client: AppClient, organizationId: string): Promise<AuditActor[]> {
  if (!isUuid(organizationId)) return [];
  const { data, error } = await client
    .from("membership")
    .select("user_id, email")
    .eq("organization_id", organizationId)
    .order("email");
  if (error) throw error;
  return [...new Map(data.map((membership) => [
    membership.user_id,
    { userId: membership.user_id, email: membership.email },
  ])).values()];
}

/** A newest-first page of an Organization's audit events. RLS limits this to Organization Administrators. */
export async function listAuditEventPage(
  client: AppClient,
  organizationId: string,
  input: AuditEventPageInput = {},
): Promise<AuditEventPage> {
  const page = Math.max(1, Math.trunc(input.page ?? 1));
  const pageSize = Math.min(100, Math.max(1, Math.trunc(input.pageSize ?? 50)));
  if (!isUuid(organizationId)) return { events: [], page, pageSize, total: 0, pageCount: 1 };
  const from = (page - 1) * pageSize;
  let query = client
    .from("audit_event")
    .select("*", { count: "exact" })
    .eq("organization_id", organizationId);
  if (input.companyId && isUuid(input.companyId)) query = query.eq("company_id", input.companyId);
  if (input.actorUserId && isUuid(input.actorUserId)) query = query.eq("actor_user_id", input.actorUserId);
  const action = input.action?.trim();
  if (action) query = query.eq("action", action);
  const fromDate = auditDate(input.from);
  if (fromDate) query = query.gte("occurred_at", fromDate.toISOString());
  const toDate = auditDate(input.to);
  if (toDate) {
    const afterTo = new Date(toDate);
    afterTo.setUTCDate(afterTo.getUTCDate() + 1);
    query = query.lt("occurred_at", afterTo.toISOString());
  }
  const { data, error, count } = await query
    .order("id", { ascending: false })
    .range(from, from + pageSize - 1);
  if (error) throw error;
  const total = count ?? 0;
  return {
    events: data.map(auditEvent),
    page,
    pageSize,
    total,
    pageCount: Math.max(1, Math.ceil(total / pageSize)),
  };
}

/** Audit events of an Organization, oldest first. Visible to its Administrators only. */
export async function listAuditEvents(client: AppClient, organizationId: string): Promise<AuditEvent[]> {
  const { data, error } = await client
    .from("audit_event")
    .select("*")
    .eq("organization_id", organizationId)
    .order("id");
  if (error) throw error;
  return data.map(auditEvent);
}
