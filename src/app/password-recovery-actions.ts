"use server";

import { refresh } from "next/cache";
import { createRequestClient } from "@/lib/supabase/server";
import { passwordRecoveryAuthentication } from "@/lib/password-recovery";
import { recoverPassword, recoveryLinkStatus, requestPasswordRecovery, verifyPasswordRecovery } from "@/application/password-recovery";
import { mfaStatus, verifyTotp } from "@/application/mfa";
import type { FormState } from "./actions";

export type RecoveryFormState = FormState & { complete?: boolean };
const field = (form: FormData, name: string) => String(form.get(name) ?? "");

export async function requestPasswordRecoveryAction(_state: RecoveryFormState, form: FormData): Promise<RecoveryFormState> {
  const email = field(form, "email");
  try {
    await requestPasswordRecovery(await createRequestClient(), passwordRecoveryAuthentication(), email);
  } catch {
    return { error: "password_recovery_failed", values: { email } };
  }
  return { error: null, values: {}, complete: true };
}

export async function recoveryLinkStatusAction(requestToken: string) {
  return recoveryLinkStatus(await createRequestClient(), requestToken);
}

export async function verifyPasswordRecoveryAction(_state: RecoveryFormState, form: FormData): Promise<RecoveryFormState> {
  const result = await verifyPasswordRecovery(await createRequestClient(), passwordRecoveryAuthentication(), {
    requestToken: field(form, "requestToken"), tokenHash: field(form, "tokenHash"),
  });
  return { error: result.ok ? null : result.error, values: {}, complete: result.ok };
}

export async function verifyRecoveryAuthenticatorAction(_state: RecoveryFormState, form: FormData): Promise<RecoveryFormState> {
  const client = await createRequestClient();
  const statusResult = await mfaStatus(client);
  if (!statusResult.ok) return { error: statusResult.error, values: {} };
  const status = statusResult.value;
  if (!status.factorId) return { error: "mfa_verification_required", values: {} };
  const result = await verifyTotp(client, { factorId: status.factorId, code: field(form, "code") });
  if (result.ok) refresh();
  return { error: result.ok ? null : result.error, values: {} };
}

export async function recoverPasswordAction(_state: RecoveryFormState, form: FormData): Promise<RecoveryFormState> {
  const result = await recoverPassword(await createRequestClient(), { newPassword: field(form, "newPassword"), confirmation: field(form, "confirmation") });
  if (!result.ok && result.error === "mfa_verification_required") refresh();
  return { error: result.ok ? null : result.error, values: {}, complete: result.ok };
}
