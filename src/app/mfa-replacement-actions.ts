"use server";

import { cookies } from "next/headers";
import { refresh } from "next/cache";
import { beginBackupRecovery, finishBackupRecovery, startReplacementEnrollment, verifyReplacementAuthenticator } from "@/application/mfa-replacement";
import type { TotpEnrollment } from "@/application/mfa";
import { createRequestClient } from "@/lib/supabase/server";
import { mfaContinuationCookie, mfaContinuationCookieOptions, mfaReplacementAuthentication } from "@/lib/mfa-replacement";
import type { RecoveryFormState } from "./password-recovery-actions";

export type ReplacementEnrollmentState = { error: string | null; enrollment: TotpEnrollment | null };

export async function beginBackupRecoveryAction(_state: RecoveryFormState, form: FormData): Promise<RecoveryFormState> {
  if (form.get("confirm") !== "yes") return { error: "mfa_replacement_confirmation_required", values: {} };
  const options = mfaContinuationCookieOptions();
  const result = await beginBackupRecovery(await createRequestClient(), { code: String(form.get("code") ?? "") });
  if (!result.ok) return { error: result.error, values: {} };
  (await cookies()).set(mfaContinuationCookie, result.value.continuationToken, options);
  refresh();
  return { error: null, values: {} };
}

export async function resumeBackupRecoveryAction(_state: RecoveryFormState): Promise<RecoveryFormState> {
  void _state;
  const options = mfaContinuationCookieOptions();
  const token = (await cookies()).get(mfaContinuationCookie)?.value ?? "";
  const result = await beginBackupRecovery(await createRequestClient(), { continuationToken: token });
  if (!result.ok) return { error: result.error, values: {} };
  (await cookies()).set(mfaContinuationCookie, result.value.continuationToken, options);
  refresh();
  return { error: null, values: {} };
}

export async function startReplacementEnrollmentAction(_state: ReplacementEnrollmentState): Promise<ReplacementEnrollmentState> {
  void _state;
  const result = await startReplacementEnrollment(await createRequestClient(), mfaReplacementAuthentication());
  return result.ok ? { error: null, enrollment: result.value } : { error: result.error, enrollment: null };
}

export async function verifyReplacementAuthenticatorAction(_state: RecoveryFormState, form: FormData): Promise<RecoveryFormState> {
  const result = await verifyReplacementAuthenticator(await createRequestClient(), String(form.get("code") ?? ""));
  if (result.ok) refresh();
  return { error: result.ok ? null : result.error, values: {} };
}

export async function finishBackupRecoveryAction(_state: RecoveryFormState, form: FormData): Promise<RecoveryFormState> {
  const result = await finishBackupRecovery(await createRequestClient(), mfaReplacementAuthentication(), {
    newPassword: String(form.get("newPassword") ?? ""), confirmation: String(form.get("confirmation") ?? ""),
  });
  if (result.ok) (await cookies()).delete(mfaContinuationCookie);
  refresh();
  return { error: result.ok ? null : result.error, values: {}, complete: result.ok };
}
