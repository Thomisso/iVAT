import type { InvitationAuthentication, InvitationAuthenticationError } from "./invitation-authentication";
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
  createdAt: string;
  status: "pending" | "expired" | "cancelled" | "replaced";
  token: string | null;
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
export type AcceptInvitationError = "invitation_invalid" | "invitation_used" | "invitation_expired" | "invitation_cancelled" | "invitation_replaced" | "forbidden";
export type InvitationOnboarding =
  | { status: "invalid" | "used" | "expired" | "cancelled" | "replaced" }
  | { status: "valid"; email: string; existingUser: boolean; companyId: string | null };
export type CompleteInvitationOnboardingError =
  | AcceptInvitationError
  | InvitationAuthenticationError
  | "invitation_busy";

function databaseRefusal(error: { code?: string; hint?: string | null }): string | null {
  if (error.code === "42501") return "forbidden";
  if (error.code === "P0001" && error.hint) return error.hint;
  return null;
}

function invitationAcceptanceUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password ? url : null;
  } catch { return null; }
}

export async function generateInvitationLink(
  client: AppClient,
  input: InviteMemberInput,
): Promise<Result<{ acceptUrl: string; token: string }, InvitationError>> {
  const email = input.email.trim().toLowerCase();
  const acceptanceUrl = invitationAcceptanceUrl(input.acceptUrl);
  if (
    !isUuid(input.organizationId) ||
    (input.companyId !== null && !isUuid(input.companyId)) ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
    (input.role !== "administrator" && input.role !== "user") ||
    (input.companyId === null && input.role !== "administrator") ||
    acceptanceUrl === null
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
    if (refusal === "forbidden" || refusal === "invalid_invitation") return { ok: false, error: refusal };
    throw error;
  }

  acceptanceUrl.hash = new URLSearchParams({ token }).toString();
  return { ok: true, value: { acceptUrl: acceptanceUrl.toString(), token } };
}

export async function inviteMember(
  client: AppClient,
  mailer: InvitationMailer,
  input: InviteMemberInput,
): Promise<Result<null, InvitationError>> {
  const generated = await generateInvitationLink(client, input);
  if (!generated.ok) return generated;
  const { token, acceptUrl } = generated.value;
  try {
    await mailer.sendInvitation({
      email: input.email.trim().toLowerCase(),
      acceptUrl,
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
    return { status: status === "used" || status === "expired" || status === "cancelled" || status === "replaced" ? status : "invalid" };
  }
  return {
    status: "valid",
    email: onboarding.invitee_email,
    existingUser: onboarding.invitee_existed,
    companyId: onboarding.target_company_id,
  };
}

function invitationRefusal(error: { code?: string; hint?: string | null }): AcceptInvitationError | null {
  const refusal = databaseRefusal(error);
  return refusal === "forbidden" || refusal === "invitation_invalid" || refusal === "invitation_used"
    || refusal === "invitation_expired" || refusal === "invitation_cancelled" || refusal === "invitation_replaced" ? refusal : null;
}

export async function completeInvitationOnboarding(
  client: AppClient,
  input: { token: string; password: string },
  authentication: InvitationAuthentication,
): Promise<Result<{ companyId: string | null }, CompleteInvitationOnboardingError>> {
  const onboarding = await getInvitationOnboarding(client, input.token);
  if (onboarding.status !== "valid") return { ok: false, error: `invitation_${onboarding.status}` };
  const current = await client.auth.getUser();
  if (current.data.user) {
    if (current.data.user.email?.toLowerCase() !== onboarding.email) return { ok: false, error: "forbidden" };
    const accepted = await acceptInvitation(client, input.token);
    return accepted.ok ? { ok: true, value: { companyId: onboarding.companyId } } : accepted;
  }
  const claimed = await client.rpc("begin_invitation_acceptance", { invitation_token: input.token });
  if (claimed.error) {
    if (databaseRefusal(claimed.error) === "invitation_busy") return { ok: false, error: "invitation_busy" };
    const refusal = invitationRefusal(claimed.error);
    if (refusal) return { ok: false, error: refusal };
    throw claimed.error;
  }
  const claimId = claimed.data;
  let temporaryClient: AppClient | null = null;
  let accepted = false;
  try {
    const authenticated = await authentication.authenticate(claimId, input.password);
    if (!authenticated.ok) {
      const current = await getInvitationOnboarding(client, input.token);
      if (current.status !== "valid") return { ok: false, error: `invitation_${current.status}` };
      return authenticated;
    }
    temporaryClient = authenticated.value.client;
    const completed = await temporaryClient.rpc("complete_invitation_acceptance", { acceptance_claim_id: claimId });
    if (completed.error) {
      const refusal = invitationRefusal(completed.error);
      if (refusal) return { ok: false, error: refusal };
      throw completed.error;
    }
    accepted = true;
    const session = authenticated.value.session;
    const published = await client.auth.setSession({ access_token: session.access_token, refresh_token: session.refresh_token });
    if (published.error) return { ok: false, error: "invitation_authentication_failed" };
    return { ok: true, value: { companyId: onboarding.companyId } };
  } finally {
    if (!accepted) {
      if (temporaryClient) await temporaryClient.auth.signOut({ scope: "local" });
      await authentication.abort(claimId);
    }
  }
}

export async function acceptInvitation(
  client: AppClient,
  token: string,
): Promise<Result<null, AcceptInvitationError>> {
  if (!token) return { ok: false, error: "invitation_invalid" };
  const { error } = await client.rpc("accept_invitation", { invitation_token: token });
  if (error) {
    const refusal = invitationRefusal(error);
    if (refusal) return { ok: false, error: refusal };
    throw error;
  }
  return { ok: true, value: null };
}
export async function replaceInvitationLink(
  client: AppClient,
  input: { invitationId: string; acceptUrl: string },
): Promise<Result<{ token: string; acceptUrl: string }, InvitationError | AcceptInvitationError>> {
  if (!isUuid(input.invitationId)) return { ok: false, error: "forbidden" };
  const url = invitationAcceptanceUrl(input.acceptUrl);
  if (!url) return { ok: false, error: "invalid_invitation" };
  const { data: token, error } = await client.rpc("replace_invitation", { target_invitation_id: input.invitationId });
  if (error) {
    const refusal = invitationRefusal(error);
    if (refusal) return { ok: false, error: refusal };
    throw error;
  }
  url.hash = new URLSearchParams({ token }).toString();
  return { ok: true, value: { token, acceptUrl: url.toString() } };
}

export async function cancelInvitation(
  client: AppClient,
  invitationId: string,
): Promise<Result<null, AcceptInvitationError>> {
  if (!isUuid(invitationId)) return { ok: false, error: "forbidden" };
  const { error } = await client.rpc("cancel_invitation_by_id", { target_invitation_id: invitationId });
  if (error) {
    const refusal = invitationRefusal(error);
    if (refusal) return { ok: false, error: refusal };
    throw error;
  }
  return { ok: true, value: null };
}

export async function listMemberships(
  client: AppClient,
  input: { organizationId: string; companyId: string | null },
): Promise<Membership[]> {
  if (!isUuid(input.organizationId) || (input.companyId !== null && !isUuid(input.companyId))) return [];
  const { data, error } = await client.rpc("list_active_memberships", {
    target_organization_id: input.organizationId,
    target_company_id: input.companyId as string,
  });
  if (error) throw error;
  const rows = data as unknown as { id: string; user_id: string; organization_id: string; company_id: string | null; email: string; role: MembershipRole }[];
  return rows.map((membership) => ({
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
  const { data, error } = await client.rpc("list_pending_invitations", {
    target_organization_id: input.organizationId,
    target_company_id: input.companyId as string,
  });
  if (error) throw error;
  return data as unknown as PendingInvitation[];
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
