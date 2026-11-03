import { authDependencyUnavailable, authUnavailable } from "./auth-availability";
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

export type ScopedMembership = {
  id: string;
  organizationId: string;
  companyId: string | null;
  scopeName: string;
  source: "company" | "organization";
  role: MembershipRole;
  manageable: boolean;
};

export type CompanyAccess = {
  membershipId: string;
  userId: string;
  email: string;
  role: MembershipRole;
  source: "company" | "organization" | "company_and_organization";
  manageableMembershipId: string | null;
  memberships: ScopedMembership[];
};

type CompanyAccessDatabaseRow = {
  membership_id: string;
  user_id: string;
  email: string;
  role: MembershipRole;
  source: CompanyAccess["source"];
  manageable_membership_id: string | null;
  memberships: {
    id: string; organization_id: string; company_id: string | null;
    scope_name: string; source: ScopedMembership["source"]; role: MembershipRole; manageable: boolean;
  }[];
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
export type AcceptInvitationError = "auth_unavailable" | "invitation_invalid" | "invitation_used" | "invitation_expired" | "invitation_cancelled" | "invitation_replaced" | "forbidden";
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
): Promise<Result<InvitationOnboarding, "auth_unavailable">> {
  const response = await client.rpc("invitation_onboarding", { invitation_token: token });
  if (authDependencyUnavailable(response)) return { ok: false, error: "auth_unavailable" };
  const { data, error } = response;
  if (error) throw error;
  const [onboarding] = data;
  if (!onboarding || onboarding.onboarding_status !== "valid") {
    const status = onboarding?.onboarding_status;
    return { ok: true, value: { status: status === "used" || status === "expired" || status === "cancelled" || status === "replaced" ? status : "invalid" } };
  }
  return { ok: true, value: {
    status: "valid",
    email: onboarding.invitee_email,
    existingUser: onboarding.invitee_existed,
    companyId: onboarding.target_company_id,
  } };
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
  const loaded = await getInvitationOnboarding(client, input.token);
  if (!loaded.ok) return loaded;
  const onboarding = loaded.value;
  if (onboarding.status !== "valid") return { ok: false, error: `invitation_${onboarding.status}` };
  const current = await client.auth.getUser();
  if (authUnavailable(current.error)) return { ok: false, error: "auth_unavailable" };
  if (current.data.user) {
    if (current.data.user.email?.toLowerCase() !== onboarding.email) return { ok: false, error: "forbidden" };
    const accepted = await acceptInvitation(client, input.token);
    return accepted.ok ? { ok: true, value: { companyId: onboarding.companyId } } : accepted;
  }
  const claimed = await client.rpc("begin_invitation_acceptance", { invitation_token: input.token });
  if (authDependencyUnavailable(claimed)) return { ok: false, error: "auth_unavailable" };
  if (claimed.error) {
    if (databaseRefusal(claimed.error) === "invitation_busy") return { ok: false, error: "invitation_busy" };
    const refusal = invitationRefusal(claimed.error);
    if (refusal) return { ok: false, error: refusal };
    throw claimed.error;
  }
  const claimId = claimed.data;
  const attempt: { client: AppClient | null; accepted: boolean } = { client: null, accepted: false };
  let result: Result<{ companyId: string | null }, CompleteInvitationOnboardingError>;
  let cleanup: Result<null, "auth_unavailable"> = { ok: true, value: null };
  try {
    result = await (async (): Promise<Result<{ companyId: string | null }, CompleteInvitationOnboardingError>> => {
      const authenticated = await authentication.authenticate(claimId, input.password);
      if (!authenticated.ok) {
        const current = await getInvitationOnboarding(client, input.token);
        if (!current.ok) return current;
        if (current.value.status !== "valid") return { ok: false, error: `invitation_${current.value.status}` };
        return authenticated;
      }
      attempt.client = authenticated.value.client;
      const completed = await attempt.client.rpc("complete_invitation_acceptance", { acceptance_claim_id: claimId });
      if (authDependencyUnavailable(completed)) return { ok: false, error: "auth_unavailable" };
      if (completed.error) {
        const refusal = invitationRefusal(completed.error);
        if (refusal) return { ok: false, error: refusal };
        throw completed.error;
      }
      attempt.accepted = true;
      const session = authenticated.value.session;
      const published = await client.auth.setSession({ access_token: session.access_token, refresh_token: session.refresh_token });
      if (authUnavailable(published.error)) return { ok: false, error: "auth_unavailable" };
      if (published.error) return { ok: false, error: "invitation_authentication_failed" };
      return { ok: true, value: { companyId: onboarding.companyId } };
    })();
  } finally {
    if (!attempt.accepted) {
      if (attempt.client) await attempt.client.auth.signOut({ scope: "local" });
      cleanup = await authentication.abort(claimId);
    }
  }
  return cleanup.ok ? result : cleanup;
}

export async function acceptInvitation(
  client: AppClient,
  token: string,
): Promise<Result<null, AcceptInvitationError>> {
  if (!token) return { ok: false, error: "invitation_invalid" };
  const response = await client.rpc("accept_invitation", { invitation_token: token });
  if (authDependencyUnavailable(response)) return { ok: false, error: "auth_unavailable" };
  const { error } = response;
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
      memberships: access.memberships.map(membership => ({
        id: membership.id, organizationId: membership.organization_id, companyId: membership.company_id,
        scopeName: membership.scope_name, source: membership.source, role: membership.role,
        manageable: membership.manageable,
      })),
    })),
  };
}

export type AccessManagementScope = { organizationId: string; companyId: string | null; name: string };
export type ManagedUser = { userId: string; email: string; effectiveRole: MembershipRole | null; memberships: ScopedMembership[] };
export type AccessManagement = {
  scope: AccessManagementScope;
  scopes: AccessManagementScope[];
  users: ManagedUser[];
  pendingInvitations: PendingInvitation[];
  blocked: boolean;
};

/** Read one authorized scope; Organization scope includes all active Company
 * Memberships without inventing a per-person Organization Role. Writes retain
 * their independent database authorization and exact Membership targets.
 * Read-only; forbidden covers invalid, foreign, deleted and unauthorized scopes.
 * Scalar JSON keeps scope choices, Users, Memberships and Invitations complete. */
export async function listAccessManagement(
  client: AppClient,
  input: { organizationId: string; companyId: string | null },
): Promise<Result<AccessManagement, "forbidden">> {
  if (!isUuid(input.organizationId) || (input.companyId !== null && !isUuid(input.companyId))) return { ok: false, error: "forbidden" };
  const { data, error } = await client.rpc("list_access_management", {
    target_organization_id: input.organizationId, target_company_id: input.companyId as string,
  });
  if (error) {
    if (databaseRefusal(error) === "forbidden") return { ok: false, error: "forbidden" };
    throw error;
  }
  const result = data as unknown as Omit<AccessManagement, "users"> & { users: CompanyAccessDatabaseRow[] };
  return { ok: true, value: { ...result, users: result.users.map(user => ({
    userId: user.user_id, email: user.email, effectiveRole: input.companyId === null ? null : user.role,
    memberships: user.memberships.map(membership => ({
      id: membership.id, organizationId: membership.organization_id, companyId: membership.company_id,
      scopeName: membership.scope_name, source: membership.source, role: membership.role, manageable: membership.manageable,
    })),
  })) } };
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
