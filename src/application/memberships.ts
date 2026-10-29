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

type CompanyAccessDatabaseRow = {
  membership_id: string;
  user_id: string;
  email: string;
  role: MembershipRole;
  source: CompanyAccess["source"];
  manageable_membership_id: string | null;
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
export type InvitationOnboarding =
  | { status: "invalid" | "used" | "expired" }
  | { status: "valid"; email: string; existingUser: boolean; companyId: string | null };
export type CompleteInvitationOnboardingError =
  | AcceptInvitationError
  | "invalid_credentials"
  | "weak_password"
  | "invitation_authentication_failed";

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
  let acceptanceUrl: URL;
  try {
    acceptanceUrl = new URL(input.acceptUrl);
  } catch {
    return { ok: false, error: "invalid_invitation" };
  }
  if (
    !isUuid(input.organizationId) ||
    (input.companyId !== null && !isUuid(input.companyId)) ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
    (input.role !== "administrator" && input.role !== "user") ||
    (input.companyId === null && input.role !== "administrator") ||
    (acceptanceUrl.protocol !== "http:" && acceptanceUrl.protocol !== "https:")
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

  acceptanceUrl.searchParams.set("token", token);
  try {
    await mailer.sendInvitation({
      email,
      acceptUrl: acceptanceUrl.toString(),
    });
  } catch {
    const cancelled = await client.rpc("cancel_invitation", { invitation_token: token });
    if (cancelled.error) throw cancelled.error;
    return { ok: false, error: "invitation_failed" };
  }
  return { ok: true, value: null };
}

export async function getInvitationOnboarding(
  client: AppClient,
  token: string,
): Promise<InvitationOnboarding> {
  const { data, error } = await client.rpc("invitation_onboarding", { invitation_token: token });
  if (error) throw error;
  const [onboarding] = data;
  if (!onboarding || onboarding.onboarding_status !== "valid") {
    const status = onboarding?.onboarding_status;
    return { status: status === "used" || status === "expired" ? status : "invalid" };
  }
  return {
    status: "valid",
    email: onboarding.invitee_email,
    existingUser: onboarding.invitee_existed,
    companyId: onboarding.target_company_id,
  };
}

export async function completeInvitationOnboarding(
  client: AppClient,
  input: { token: string; password: string },
): Promise<Result<{ companyId: string | null }, CompleteInvitationOnboardingError>> {
  const onboarding = await getInvitationOnboarding(client, input.token);
  if (onboarding.status !== "valid") {
    return { ok: false, error: `invitation_${onboarding.status}` };
  }

  if (onboarding.existingUser) {
    const { error } = await client.auth.signInWithPassword({
      email: onboarding.email,
      password: input.password,
    });
    if (error) return { ok: false, error: "invalid_credentials" };
  } else {
    if (input.password.length < 8) return { ok: false, error: "weak_password" };
    const { data } = await client.auth.getUser();
    if (data.user?.email?.toLowerCase() !== onboarding.email) {
      return { ok: false, error: "invitation_authentication_failed" };
    }
    const { error } = await client.auth.updateUser({ password: input.password });
    if (error) {
      return {
        ok: false,
        error: error.code === "weak_password" ? "weak_password" : "invitation_authentication_failed",
      };
    }
  }

  const accepted = await acceptInvitation(client, input.token);
  if (!accepted.ok) return accepted;
  return { ok: true, value: { companyId: onboarding.companyId } };
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
): Promise<Result<CompanyAccess[], "forbidden">> {
  if (!isUuid(companyId)) return { ok: false, error: "forbidden" };
  const { data, error } = await client.rpc("list_company_access", {
    target_company_id: companyId,
  });
  if (error) {
    if (databaseRefusal(error) === "forbidden") return { ok: false, error: "forbidden" };
    throw error;
  }
  return {
    ok: true,
    value: (data as unknown as CompanyAccessDatabaseRow[]).map((access) => ({
      membershipId: access.membership_id,
      userId: access.user_id,
      email: access.email,
      role: access.role,
      source: access.source,
      manageableMembershipId: access.manageable_membership_id,
    })),
  };
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
