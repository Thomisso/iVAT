import type { Json } from "@/lib/database.types";
import type { AppClient } from "./client";

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

/** Audit events of an Organization, oldest first. Visible to its Administrators only. */
export async function listAuditEvents(client: AppClient, organizationId: string): Promise<AuditEvent[]> {
  const { data, error } = await client
    .from("audit_event")
    .select("*")
    .eq("organization_id", organizationId)
    .order("id");
  if (error) throw error;
  return data.map((e) => ({
    id: e.id,
    occurredAt: e.occurred_at,
    actorUserId: e.actor_user_id,
    organizationId: e.organization_id,
    companyId: e.company_id,
    action: e.action,
    targetType: e.target_type,
    targetId: e.target_id,
    payload: e.payload,
  }));
}
