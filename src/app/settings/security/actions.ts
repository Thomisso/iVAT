"use server";

import type { FormState } from "@/app/actions";
import { changePassword } from "@/application/password-change";
import { supabasePasswordVerifier } from "@/application/supabase-password-verifier";
import { supabasePublishableKey, supabaseUrl } from "@/lib/env";
import { requireUserClient } from "@/lib/supabase/server";

export type PasswordChangeState = FormState & { succeeded: boolean };

export async function changePasswordAction(_state: PasswordChangeState, form: FormData): Promise<PasswordChangeState> {
  const result = await changePassword(await requireUserClient(), supabasePasswordVerifier(supabaseUrl, supabasePublishableKey), {
    currentPassword: String(form.get("currentPassword") ?? ""),
    newPassword: String(form.get("newPassword") ?? ""),
    confirmation: String(form.get("confirmation") ?? ""),
  });
  // Password values are never returned to the browser, including on refusals.
  return { error: result.ok ? null : result.error, values: {}, succeeded: result.ok };
}
