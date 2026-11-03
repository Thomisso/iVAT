import type { Session } from "@supabase/supabase-js";
import type { AppClient, Result } from "./client";

export type InvitationAuthenticationError = "auth_unavailable" | "invalid_credentials" | "weak_password" | "invitation_authentication_failed" | "invitation_identity_changed";

/** A server-only Auth capability scoped by a database-issued acceptance claim. */
export interface InvitationAuthentication {
  authenticate(claimId: string, password: string): Promise<Result<{ client: AppClient; session: Session }, InvitationAuthenticationError>>;
  abort(claimId: string): Promise<Result<null, "auth_unavailable">>;
}
