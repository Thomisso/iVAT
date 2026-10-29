import { isUuid, type AppClient, type Result } from "./client";

export type MembershipRole = "administrator" | "user";

export type Membership = {
  id: string;
  userId: string;
  organizationId: string;
  companyId: string | null;
  email: string;
  role: MembershipRole;
};

export type CompanyAccess = {
  membershipId: string;
  userId: string;
  email: string;
  role: MembershipRole;
  source: "company" | "organization" | "company_and_organization";
  manageableMembershipId: string | null;
};

export type PendingInvitation = {
  id: string;
  email: string;
  role: MembershipRole;
  expiresAt: string;
  status: "pending" | "expired";
};

export interface InvitationMailer {
  sendInvitation(message: { email: string; acceptUrl: string }): Promise<void>;
}

export type InviteMemberInput = {
  organizationId: string;
  companyId: string | null;
  email: string;
  role: MembershipRole;
  acceptUrl: string;
};

export type InvitationError = "invalid_invitation" | "forbidden" | "invitation_failed";
export type AcceptInvitationError = "invitation_invalid" | "invitation_used" | "invitation_expired" | "forbidden";

function databaseRefusal(error: { code?: string; hint?: string | null }): string | null {
  if (error.code === "42501") return "forbidden";
  if (error.code === "P0001" && error.hint) return error.hint;
  return null;
}

export async function inviteMember(
  client: AppClient,
  mailer: InvitationMailer,
  input: InviteMemberInput,
): Promise<Result<null, InvitationError>> {
  const email = input.email.trim().toLowerCase();
  if (
    !isUuid(input.organizationId) ||
    (input.companyId !== null && !isUuid(input.companyId)) ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
    (input.role !== "administrator" && input.role !== "user") ||
    (input.companyId === null && input.role !== "administrator")
  ) {
    return { ok: false, error: "invalid_invitation" };
  }

  const { data: token, error } = await client.rpc("create_invitation", {
    target_organization_id: input.organizationId,
    // Postgres function arguments can be null although generated RPC argument types cannot express it.
    target_company_id: input.companyId as string,
    target_email: email,
    target_role: input.role,
  });
  if (error) {
    const refusal = databaseRefusal(error);
    if (refusal === "forbidden") return { ok: false, error: refusal };
    throw error;
  }

  const separator = input.acceptUrl.includes("?") ? "&" : "?";
  try {
    await mailer.sendInvitation({
      email,
      acceptUrl: `${input.acceptUrl}${separator}token=${encodeURIComponent(token)}`,
    });
  } catch {
    const cancelled = await client.rpc("cancel_invitation", { invitation_token: token });
    if (cancelled.error) throw cancelled.error;
    return { ok: false, error: "invitation_failed" };
  }
  return { ok: true, value: null };
}
export async function acceptInvitation(
  client: AppClient,
  token: string,
): Promise<Result<null, AcceptInvitationError>> {
  if (!token) return { ok: false, error: "invitation_invalid" };
  const { error } = await client.rpc("accept_invitation", { invitation_token: token });
  if (error) {
    const refusal = databaseRefusal(error);
    if (refusal === "forbidden") return { ok: false, error: "forbidden" };
    if (refusal === "invitation_invalid" || refusal === "invitation_used" || refusal === "invitation_expired") {
      return { ok: false, error: refusal };
    }
    throw error;
  }
  return { ok: true, value: null };
}
export async function listMemberships(
  client: AppClient,
  input: { organizationId: string; companyId: string | null },
): Promise<Membership[]> {
  if (!isUuid(input.organizationId) || (input.companyId !== null && !isUuid(input.companyId))) return [];
  let query = client.from("membership").select("id, user_id, organization_id, company_id, email, role")
    .eq("organization_id", input.organizationId);
  query = input.companyId === null ? query.is("company_id", null) : query.eq("company_id", input.companyId);
  const { data, error } = await query.order("created_at");
  if (error) throw error;
  return data.map((membership) => ({
    id: membership.id,
    userId: membership.user_id,
    organizationId: membership.organization_id,
    companyId: membership.company_id,
    email: membership.email,
    role: membership.role,
  }));
}

export async function listCompanyAccess(
  client: AppClient,
  companyId: string,
): Promise<CompanyAccess[]> {
  if (!isUuid(companyId)) return [];
  const { data, error } = await client.rpc("list_company_access", {
    target_company_id: companyId,
  });
  if (error) {
    if (databaseRefusal(error) === "forbidden") return [];
    throw error;
  }
  return data.map((access) => ({
    membershipId: access.membership_id,
    userId: access.user_id,
    email: access.email,
    role: access.role,
    source: access.source as CompanyAccess["source"],
    manageableMembershipId: access.manageable_membership_id,
  }));
}

export async function listPendingInvitations(
  client: AppClient,
  input: { organizationId: string; companyId: string | null },
): Promise<PendingInvitation[]> {
  if (!isUuid(input.organizationId) || (input.companyId !== null && !isUuid(input.companyId))) return [];
  let query = client.from("invitation").select("id, email, role, expires_at")
    .eq("organization_id", input.organizationId)
    .is("accepted_at", null);
  query = input.companyId === null ? query.is("company_id", null) : query.eq("company_id", input.companyId);
  const { data, error } = await query.order("created_at");
  if (error) throw error;
  const now = Date.now();
  return data.map((invitation) => ({
    id: invitation.id,
    email: invitation.email,
    role: invitation.role,
    expiresAt: invitation.expires_at,
    status: Date.parse(invitation.expires_at) <= now ? "expired" : "pending",
  }));
}

export async function changeMembershipRole(
  client: AppClient,
  input: { membershipId: string; role: MembershipRole },
): Promise<Result<null, "forbidden">> {
  if (!isUuid(input.membershipId) || (input.role !== "administrator" && input.role !== "user")) {
    return { ok: false, error: "forbidden" };
  }
  const { error } = await client.rpc("change_membership_role", {
    target_membership_id: input.membershipId,
    target_role: input.role,
  });
  if (error) {
    if (databaseRefusal(error) === "forbidden") return { ok: false, error: "forbidden" };
    throw error;
  }
  return { ok: true, value: null };
}

export async function removeMembership(
  client: AppClient,
  membershipId: string,
): Promise<Result<null, "forbidden">> {
  if (!isUuid(membershipId)) return { ok: false, error: "forbidden" };
  const { error } = await client.rpc("remove_membership", { target_membership_id: membershipId });
  if (error) {
    if (databaseRefusal(error) === "forbidden") return { ok: false, error: "forbidden" };
    throw error;
  }
  return { ok: true, value: null };
}
